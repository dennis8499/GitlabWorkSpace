export interface GitDiffLine {
  text: string;
  kind: 'meta' | 'context' | 'add' | 'remove' | 'hunk';
  hunk: number;
}

export function makeDiffLines(diff: string): GitDiffLine[] {
  let hunk = -1;
  return diff.split(/\r?\n/).map((text) => {
    if (text.startsWith('@@')) { hunk++; return { text, kind: 'hunk', hunk }; }
    if (text.startsWith('+') && !text.startsWith('+++')) return { text, kind: 'add', hunk };
    if (text.startsWith('-') && !text.startsWith('---')) return { text, kind: 'remove', hunk };
    if (text.startsWith('diff --git ') || text.startsWith('index ') || text.startsWith('---') || text.startsWith('+++') || text.startsWith('new file') || text.startsWith('deleted file')) return { text, kind: 'meta', hunk };
    return { text, kind: 'context', hunk };
  });
}

export function makeSelectedPatch(diff: string, file: string, selectedLines: number[]): string {
  if (!file || file.includes('\0') || /[\r\n]/.test(file)) return '';
  const rows = diff.split(/\r?\n/);
  const header = rows.filter((row) => row.startsWith('diff --git ') || row.startsWith('--- ') || row.startsWith('+++ '));
  if (!header.some((row) => row.includes('a/' + file)) || !header.some((row) => row.includes('b/' + file))) return '';
  const chosen = new Set(selectedLines.filter((line) => Number.isSafeInteger(line) && line >= 0 && line < rows.length));
  let oldLine = 0;
  let newLine = 0;
  const hunks: string[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (match) { oldLine = Number(match[1]); newLine = Number(match[3]); continue; }
    if (row.startsWith('\\ No newline')) continue;
    if (row.startsWith('+') && !row.startsWith('+++')) {
      if (chosen.has(index)) hunks.push('@@ -' + oldLine + ',0 +' + newLine + ',1 @@\n' + row);
      newLine++;
    } else if (row.startsWith('-') && !row.startsWith('---')) {
      if (chosen.has(index)) hunks.push('@@ -' + oldLine + ',1 +' + newLine + ',0 @@\n' + row);
      oldLine++;
    } else if (!row.startsWith('diff --git ') && !row.startsWith('index ') && !row.startsWith('--- ') && !row.startsWith('+++ ') && !row.startsWith('@@')) {
      oldLine++; newLine++;
    }
  }
  if (!hunks.length) return '';
  return header.slice(0, 1).concat(header.filter((row) => row.startsWith('--- ') || row.startsWith('+++ '))).join('\n') + '\n' + hunks.join('\n') + '\n';
}
