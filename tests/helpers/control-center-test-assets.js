import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function createControlCenterTestAssetRoot(workspaceRoot) {
  const assetRoot = path.join(workspaceRoot, '.test-control-center-assets');
  await mkdir(assetRoot, { recursive: true });
  await writeFile(
    path.join(assetRoot, 'index.html'),
    '<!doctype html><html lang="en"><head><meta charset="UTF-8"></head><body>Control Center test asset</body></html>\n',
    'utf8'
  );
  return assetRoot;
}
