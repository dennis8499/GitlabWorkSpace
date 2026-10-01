export function pythonCommandCandidates(platform = process.platform) {
  return platform === 'win32'
    ? [
        { executable: 'python', args: [] },
        { executable: 'python3', args: [] },
        { executable: 'py', args: ['-3'] }
      ]
    : [
        { executable: 'python3', args: [] },
        { executable: 'python', args: [] }
      ];
}

export function pythonUtf8Environment(environment = process.env) {
  return { ...environment, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
}

export function supportsPython311(versionOutput) {
  const version = /Python\s+(\d+)\.(\d+)/.exec(versionOutput);
  return !!version && (Number(version[1]) > 3 || (Number(version[1]) === 3 && Number(version[2]) >= 11));
}
