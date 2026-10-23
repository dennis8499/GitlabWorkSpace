/** Stable Release ordering, with prerelease Extension versions below their final version. */
export function compareVersions(first: string, second: string): number {
  const parts = (value: string) => value.split(/[+-]/, 1)[0].split('.').map(Number);
  const a = parts(first), b = parts(second);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return Number(second.includes('-')) - Number(first.includes('-'));
}
