/**
 * App-server renders command argv with shlex_join, including on Windows:
 * https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/app-server-protocol/src/protocol/item_builders.rs
 * This is an argv display decoder, never a shell parser or command executor.
 */
const utf8OutputPrefix = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n';
const separator = (value: string): boolean => value === ' ' || value === '\t';
const unsafeBareCharacter = (value: string): boolean => '&;|<>$`(){}!#\r\n'.includes(value);

/** Decode only literal shell_words/shlex quoting; expansions and comments stay opaque. */
function posixArgv(value: string): string[] | undefined {
  const argv: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (separator(value[index])) index++;
    if (index === value.length) break;
    let word = '', quote: "'" | '"' | undefined;
    while (index < value.length) {
      const char = value[index++];
      if (!quote && separator(char)) break;
      if (quote === "'") {
        if (char === "'") {
          // PowerShell's doubled-apostrophe notation is not shlex quoting.
          if (value[index] === "'") return undefined;
          quote = undefined;
        } else word += char;
      } else if (char === "'" && !quote) quote = "'";
      else if (char === '"') {
        // Adjacent double quotes differ between Windows CRT and POSIX displays.
        if (value[index] === '"') return undefined;
        quote = quote ? undefined : '"';
      }
      else if (char === '\\') {
        if (index === value.length || value[index] === '\n' || value[index] === '\r') return undefined;
        const next = value[index];
        if (!quote || '$`"\\'.includes(next)) { word += next; index++; }
        else word += char;
      } else {
        if (!quote && unsafeBareCharacter(char)) return undefined;
        word += char;
      }
    }
    if (quote) return undefined;
    argv.push(word);
  }
  return argv;
}

/** Literal Windows display quoting. Apostrophes outside double quotes are ambiguous. */
function windowsArgv(value: string): string[] | undefined {
  const argv: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (separator(value[index])) index++;
    if (index === value.length) break;
    let word = '', quoted = false;
    while (index < value.length && (quoted || !separator(value[index]))) {
      const char = value[index++];
      if (char === '\\') {
        let count = 1;
        while (value[index] === '\\') { count++; index++; }
        if (value[index] === '"') {
          if (count % 2 === 0 && value[index + 1] === '"') return undefined;
          word += '\\'.repeat(Math.floor(count / 2));
          if (count % 2) word += '"';
          else quoted = !quoted;
          index++;
        } else word += '\\'.repeat(count);
      } else if (char === '"') {
        if (value[index] === '"') return undefined;
        quoted = !quoted;
      }
      else {
        if (!quoted && (char === "'" || unsafeBareCharacter(char))) return undefined;
        word += char;
      }
    }
    if (quoted) return undefined;
    argv.push(word);
  }
  return argv;
}

function shellBody(argv: readonly string[]): string | undefined {
  const executable = argv[0]?.split(/[\\/]/).at(-1)?.toLowerCase();
  if (!executable || argv.length < 3) return undefined;
  if (/^(?:bash|zsh|sh)(?:\.exe)?$/.test(executable)) {
    return argv.length === 3 && (argv[1] === '-c' || argv[1] === '-lc') ? argv[2] : undefined;
  }
  if (!/^(?:powershell|pwsh)(?:\.exe)?$/.test(executable)) return undefined;
  const flags = new Set<string>();
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index].toLowerCase();
    if (flag === '-command' || flag === '-c') {
      if (index + 2 !== argv.length) return undefined;
      const body = argv[index + 1];
      // Only the exact audited encoding prefix in Codex 0.167.2 is transparent:
      // https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/shell-command/src/powershell.rs
      return body.startsWith(utf8OutputPrefix) ? body.slice(utf8OutputPrefix.length) : body;
    }
    if (!['-nologo', '-noprofile', '-noninteractive'].includes(flag) || flags.has(flag)) return undefined;
    flags.add(flag);
  }
  return undefined;
}

/**
 * Recover the entire body of one recognized shell wrapper. No recursive unwrap,
 * whitespace folding, substring matching, script parsing, or extra argv removal.
 * Ambiguous POSIX/Windows displays and unknown wrappers fail closed.
 */
export function normalizeNativeCommand(value: string): string | undefined {
  if (!value || value.includes('\0')) return undefined;
  const candidates = new Set<string>();
  for (const parse of [posixArgv, windowsArgv]) {
    const argv = parse(value);
    const body = argv && shellBody(argv);
    if (body !== undefined) candidates.add(body);
  }
  return candidates.size === 1 ? candidates.values().next().value : undefined;
}

/** Unknown display formats may pass only when the complete raw command is exact. */
export function matchesNativeCommand(actual: string, expected: string): boolean {
  return actual === expected || normalizeNativeCommand(actual) === expected;
}
