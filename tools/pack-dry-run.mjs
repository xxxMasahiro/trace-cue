#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT_IDENTITY } from '../src/product-identity.js';
import {
  cleanupPackageArtifactWorkspace,
  createPackageArtifactWorkspace,
  runBoundedCommandToFile
} from './lib/package-artifact.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const MAX_PACK_MANIFEST_BYTES = 8 * 1024 * 1024;

await main();

async function main() {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  if (packageJson.name !== PRODUCT_IDENTITY.packageName || packageJson.version !== PRODUCT_IDENTITY.packageVersion) {
    throw new Error('package.json name/version does not match PRODUCT_IDENTITY.');
  }
  const workspace = await createPackageArtifactWorkspace(`${PRODUCT_IDENTITY.npmCacheDirectoryName}-dry-run-`);
  try {
    const output = await runBoundedCommandToFile({
      command: 'npm',
      args: [
        'pack',
        '--dry-run',
        '--json',
        '--cache',
        workspace.cacheDir,
        '--ignore-scripts'
      ],
      cwd: repoRoot,
      outputPath: path.join(workspace.root, 'npm-pack-dry-run.json'),
      maxBytes: MAX_PACK_MANIFEST_BYTES
    });
    const packed = JSON.parse(output);
    if (!Array.isArray(packed) || packed.length !== 1 || !Array.isArray(packed[0]?.files)) {
      throw new Error('npm pack dry-run did not return one package file manifest.');
    }
    const files = new Set(packed[0].files.map((entry) => entry.path));
    const controlCenterPrefix = `${PRODUCT_IDENTITY.controlCenterDistPath}/`;
    if (!files.has(`${controlCenterPrefix}${PRODUCT_IDENTITY.controlCenterEntryFile}`)
      || ![...files].some((entry) => entry.startsWith(controlCenterPrefix) && entry.endsWith('.js'))
      || ![...files].some((entry) => entry.startsWith(controlCenterPrefix) && entry.endsWith('.css'))) {
      throw new Error('npm package is missing the built Control Center HTML, JavaScript, or CSS.');
    }
    process.stdout.write(`Package dry run passed (${packed[0].files.length} file(s)).\n`);
  } finally {
    await cleanupPackageArtifactWorkspace(workspace);
  }
}
