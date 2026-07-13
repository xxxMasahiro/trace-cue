#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT_IDENTITY } from '../src/product-identity.js';
import {
  cleanupPackageArtifactWorkspace,
  createPackageArtifactWorkspace
} from './lib/package-artifact.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

await main();

async function main() {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  if (packageJson.name !== PRODUCT_IDENTITY.packageName || packageJson.version !== PRODUCT_IDENTITY.packageVersion) {
    throw new Error('package.json name/version does not match PRODUCT_IDENTITY.');
  }
  const workspace = await createPackageArtifactWorkspace(`${PRODUCT_IDENTITY.npmCacheDirectoryName}-dry-run-`);
  try {
    const output = await runCapture('npm', [
      'pack',
      '--dry-run',
      '--json',
      '--cache',
      workspace.cacheDir,
      '--ignore-scripts'
    ]);
    const packed = JSON.parse(output);
    if (!Array.isArray(packed) || packed.length !== 1 || !Array.isArray(packed[0]?.files)) {
      throw new Error('npm pack dry-run did not return one package file manifest.');
    }
    process.stdout.write(`Package dry run passed (${packed[0].files.length} file(s)).\n`);
  } finally {
    await cleanupPackageArtifactWorkspace(workspace);
  }
}

function runCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, shell: false, stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}
