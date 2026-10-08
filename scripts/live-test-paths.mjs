import path from 'node:path';

export function sameFilesystemPath(left, right, platform = process.platform) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const normalizedLeft = pathApi.resolve(left);
  const normalizedRight = pathApi.resolve(right);
  return platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}

/** Portable mode overrides the CLI path; every cold run needs its own portable root. */
export function createLiveTestProfile(testRoot, profileId, portable) {
  if (!/^[a-z0-9-]+$/i.test(profileId)) throw new Error("Invalid isolated profile ID.");
  const profileRoot = path.resolve(testRoot, "live-" + profileId);
  const portableRoot = path.join(profileRoot, "portable");
  const userData = portable ? path.join(portableRoot, "user-data") : profileRoot;
  const extensions = portable ? path.join(portableRoot, "extensions") : path.resolve(testRoot, "extensions-" + profileId);
  return { userData, extensions, environment: portable ? { VSCODE_PORTABLE: portableRoot } : {},
    cleanupPaths: portable ? [profileRoot] : [profileRoot, extensions] };
}
