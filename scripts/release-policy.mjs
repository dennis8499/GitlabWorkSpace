const numericIdentifier = '(?:0|[1-9]\\d*)';
const prereleaseIdentifier = '(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)';
const buildIdentifier = '[0-9A-Za-z-]+';
const semverPattern = new RegExp(
  `^${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}` +
  `(?:-(${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*))?` +
  `(?:\\+${buildIdentifier}(?:\\.${buildIdentifier})*)?$`
);

export function parseReleaseTag(tag) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) {
    throw new Error('release tag must start with v and use a semantic version');
  }

  const version = tag.slice(1);
  if (!semverPattern.test(version)) {
    throw new Error(`release tag ${tag} must use a semantic version`);
  }
  return version;
}

export function releaseIsPrerelease(tag) {
  const version = parseReleaseTag(tag);
  const versionWithoutBuild = version.split('+', 1)[0];
  return tag === 'v0.1.0' || versionWithoutBuild.includes('-');
}

export function releaseAssetName(manifest) {
  if (!manifest || typeof manifest.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.name)) {
    throw new Error('package.json must contain a safe extension name');
  }
  if (typeof manifest.version !== 'string' || !semverPattern.test(manifest.version)) {
    throw new Error('package.json must contain a semantic version');
  }
  return `${manifest.name}-${manifest.version}.vsix`;
}

export function validateReleaseManifest({ tag, manifest, lockfile, isOnMain }) {
  const version = parseReleaseTag(tag);

  if (!manifest || manifest.version !== version) {
    throw new Error(`release tag ${tag} does not match package.json version`);
  }

  const lockRoot = lockfile?.packages?.[''];
  if (lockfile?.version !== version || lockRoot?.version !== version) {
    throw new Error(`release tag ${tag} does not match package-lock.json version`);
  }
  if (lockfile.name !== manifest.name || lockRoot.name !== manifest.name) {
    throw new Error('package.json and package-lock.json names do not match');
  }

  if (isOnMain !== true) {
    throw new Error('release commit is not contained in main');
  }

  return {
    version,
    assetName: releaseAssetName(manifest),
    prerelease: releaseIsPrerelease(tag)
  };
}
