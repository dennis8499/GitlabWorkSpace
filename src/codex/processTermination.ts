/** taskkill can report exited descendants as failures after killing the root. */
export function windowsTaskkillComplete(code: number | null, rootPid: number, output: string,
  gone: (pid: number) => boolean = pid => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  }): boolean {
  if (code === 0) return true;
  if (code !== 128 || output.length > 1024 * 1024 || !Number.isSafeInteger(rootPid) || rootPid < 1) return false;
  // Only the first PID on each localized line is the target. A later PID is
  // its parent and may be this still-running supervisor. PID and digits are
  // ASCII even when taskkill emits the rest of the line in an OEM code page.
  const targets = [...new Set(output.split(/[\r\n]+/).flatMap(line => {
    const match = /\bPID[^\d\r\n]{0,32}(\d+)/i.exec(line);
    return match ? [Number(match[1])] : [];
  }))];
  return targets.length <= 4096 && targets.includes(rootPid) &&
    targets.every(pid => Number.isSafeInteger(pid) && pid > 0 && gone(pid));
}
