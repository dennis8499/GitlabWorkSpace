import { rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const outputPath = resolve(repositoryRoot, 'out');
if (!outputPath.startsWith(`${repositoryRoot}${sep}`)) throw new Error('Refusing to remove a path outside the repository.');
await rm(outputPath, { recursive: true, force: true });
