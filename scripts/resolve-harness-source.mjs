import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
export function resolveHarnessSource(sourceRoot) {
  const root = resolve(sourceRoot);
  const unpacked = join(root, 'third_party/deepseek-harness');
  if (existsSync(join(unpacked, 'HARNESS_SOURCE.json'))) return unpacked;
  const archive = join(root, 'third_party/deepseek-harness-source.tar.gz');
  if (!existsSync(archive)) throw new Error('The pinned Harness source archive is missing.');
  const release = JSON.parse(readFileSync(join(root, 'release.json'), 'utf8'));
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  const cache = resolve(process.env.NEXUS_CACHE_DIR || join(homedir(), '.cache/NexusRoom/build-cache/v' + release.version));
  if (cache === root || cache.startsWith(root + sep)) throw new Error('Harness extraction cache must stay outside the source tree.');
  const target = join(cache, 'sources/archive-' + digest);
  const source = join(target, 'deepseek-harness');
  const stamp = join(target, 'ARCHIVE.sha256');
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === digest && existsSync(join(source, 'HARNESS_SOURCE.json'))) return source;
  if (existsSync(target)) throw new Error('Incomplete Harness extraction cache; remove only this archive-specific cache and retry.');
  const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).trim().split(/\r?\n/);
  if (!names.length || names.some(name => !name.startsWith('deepseek-harness/') || name.includes('\\') || name.split('/').some(part => part === '..' || part === '.') || /[\x00-\x1f]/.test(name))) throw new Error('Unsafe Harness source archive member.');
  const listing = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (listing.trim().split(/\r?\n/).some(line => !/^[-d]/.test(line))) throw new Error('Harness archive contains a link or special file.');
  mkdirSync(target, { recursive: true });
  try {
    execFileSync('tar', ['-xzf', archive, '-C', target], { windowsHide: true });
    const inventory = JSON.parse(readFileSync(join(root, 'third_party/HARNESS_SOURCE.json'), 'utf8'));
    const embedded = JSON.parse(readFileSync(join(source, 'HARNESS_SOURCE.json'), 'utf8'));
    if (JSON.stringify(inventory) !== JSON.stringify(embedded) || inventory.commit !== release.pcKernel.commit) throw new Error('Harness source identity mismatch.');
    const declared = new Set(inventory.files.map(file => file.path));
    function walk(directory) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (lstatSync(path).isSymbolicLink()) throw new Error('Harness extraction contains a filesystem link.');
        if (entry.isDirectory()) walk(path);
      }
    }
    walk(source);
    for (const file of inventory.files) {
      const path = resolve(source, file.path);
      if (!path.startsWith(source + sep) || !declared.has(file.path) || createHash('sha256').update(readFileSync(path)).digest('hex') !== file.sha256) throw new Error('Harness source digest mismatch: ' + file.path);
    }
    writeFileSync(stamp, digest);
    return source;
  } catch (error) { rmSync(target, { recursive: true, force: true }); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(resolveHarnessSource(resolve(dirname(fileURLToPath(import.meta.url)), '..')));
