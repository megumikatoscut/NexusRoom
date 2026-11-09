import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

// LibreOffice's native Windows engine cannot load from some deep extraction
// paths. A junction keeps the immutable shipped payload in place and needs no
// administrator rights. Node must preserve this path when resolving modules.
export function ensureRuntimePath(runtime) {
  const target = realpathSync.native(resolve(runtime));
  if (process.platform !== 'win32') return target;
  const canonical = path => path.toLowerCase();
  const key = createHash('sha256').update(canonical(target)).digest('hex').slice(0, 20);
  const parent = join(tmpdir(), 'NexusRoom-runtime');
  const alias = join(parent, key);
  mkdirSync(parent, { recursive: true });
  try { symlinkSync(target, alias, 'junction'); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!lstatSync(alias).isSymbolicLink() || canonical(realpathSync.native(alias)) !== canonical(target))
    throw new Error('NexusRoom runtime junction points to an unexpected directory: ' + alias);
  return alias;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node harness-runtime-path.mjs <runtime directory>');
  console.log(JSON.stringify(ensureRuntimePath(process.argv[2])));
}
