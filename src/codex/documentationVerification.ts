/** Conservative filename classification; the Host separately verifies regular files and their digest. */
export function isDocumentationOnly(files: readonly string[]): boolean {
  if (!Array.isArray(files) || !files.length || files.length > 50_000) return false;
  const excluded = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'config', 'configs', 'configuration', 'code', 'src', 'source',
    'scripts', 'script', 'node_modules', 'bin', 'obj', 'dist', 'out', 'build', '_bmad', '_bmad-output']);
  return files.every(file => {
    if (typeof file !== 'string' || !file || file.length > 4096 || /[\\:]/.test(file) || [...file].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || file.startsWith('/') || file.endsWith('/')) return false;
    const parts = file.toLowerCase().split('/');
    if (parts.some(part => !part || part.startsWith('.') || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/.test(part)) || parts.slice(0, -1).some(part => excluded.has(part))) return false;
    const name = parts.at(-1)!;
    if (/^(?:requirements(?:[._-].*)?|constraints(?:[._-].*)?|cmakelists|runtime|packages)\.txt$/.test(name)) return false;
    if (/\.(?:md|mdx|rst|txt)$/.test(name)) return true;
    return parts[0] === 'docs' && /\.(?:png|jpe?g|gif|webp|avif|ico|bmp)$/.test(name);
  });
}
