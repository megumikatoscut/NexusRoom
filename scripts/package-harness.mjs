import { fileURLToPath } from 'node:url';
import { resolveHarnessSource } from './resolve-harness-source.mjs';
import { cpSync, existsSync, globSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { source: { type: 'string' }, output: { type: 'string' }, 'verify-source-only': { type: 'boolean' } } });
const source = values.source ? resolve(values.source) : resolveHarnessSource(fileURLToPath(new URL('../', import.meta.url)));
const output = resolve(values.output || '.local/harness-package');
const release = JSON.parse(readFileSync(new URL('../release.json', import.meta.url), 'utf8'));
if (existsSync(output) || output === source || source.startsWith(output + sep)) throw new Error('Runtime output must be a new directory outside the Harness source');
let commit;
const snapshotPath = join(source, 'HARNESS_SOURCE.json');
if (existsSync(snapshotPath)) {
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  if (snapshot.repository !== release.pcKernel.repository || snapshot.commit !== release.pcKernel.commit || snapshot.version !== release.pcKernel.upstreamVersion)
    throw new Error('Harness source snapshot does not match release.json');
  const paths = new Set();
  if (!Array.isArray(snapshot.files) || snapshot.files.length === 0) throw new Error('Harness source snapshot has no file inventory');
  for (const file of snapshot.files) {
    const path = resolve(source, file.path);
    if (!path.startsWith(source + sep) || paths.has(path) || lstatSync(path).isSymbolicLink()) throw new Error('Invalid Harness source snapshot path');
    paths.add(path);
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== file.sha256) throw new Error('Harness source snapshot changed: ' + file.path);
  }
  commit = snapshot.commit;
} else {
  const gitRoot = resolve(execFileSync('git', ['-C', source, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true }).trim());
  if (gitRoot.toLowerCase() !== source.toLowerCase()) throw new Error('Harness source must be its pinned repository or a verified source snapshot');
  commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  if (commit !== release.pcKernel.commit) throw new Error('Harness source does not match release.json');
  const dirty = execFileSync('git', ['-C', source, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).trim();
  if (dirty) throw new Error('Harness source has uncommitted changes');
}
const upstream = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
if (upstream.version !== release.pcKernel.upstreamVersion) throw new Error('Harness version does not match release.json');
if (values['verify-source-only']) {
  console.log(`PASS pinned Harness source ${upstream.version} (${commit.slice(0, 12)})`);
  process.exit(0);
}

const seeds = [
  'apps/cli', 'packages/computer-use/computer-use',
  'packages/experimental/computer-use-cua-driver-native',
  'packages/browser-use/browser-use', 'packages/experimental/browser-use-playwright-mcp',
];
const modules = join(output, 'node_modules');
const installed = new Map();
const queue = [];
const inventory = [];
const forbidden = new Set(['.git', '.env', '.cache', '.history', '.DS_Store', 'node_modules']);

function manifest(path) { return JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')); }
function inside(path, root) { return path === root || path.startsWith(root + sep); }
function supported(list, current) {
  return !list || (!list.includes('!' + current) && (list.every(value => value.startsWith('!')) || list.includes(current)));
}
function findDependency(parent, name) {
  for (let directory = parent; inside(directory, source); directory = dirname(directory)) {
    const path = join(directory, 'node_modules', name);
    if (existsSync(join(path, 'package.json'))) return realpathSync(path);
    if (directory === source) break;
  }
  return null;
}
function keepFile(path, root) {
  const parts = relative(root, path).split(sep);
  return !parts.some(part => forbidden.has(part) || part.startsWith('.env.'))
    && !/\.(?:tsbuildinfo|map)$/i.test(path) && !/\.d\.[cm]?ts$/i.test(path);
}
function copyPackage(from, to) {
  const pkg = manifest(from);
  mkdirSync(to, { recursive: true });
  const workspace = inside(from, source) && !relative(source, from).split(sep).includes('node_modules');
  if (workspace) {
    if (!pkg.files?.length) throw new Error('Workspace package has no publication files: ' + pkg.name);
    const patterns = [...pkg.files.filter(pattern => !pattern.startsWith('!')), 'package.json', 'LICENSE*', 'NOTICE*', 'README*'];
    for (const path of globSync(patterns, { cwd: from })) {
      const input = join(from, path);
      if (!keepFile(input, from)) continue;
      mkdirSync(dirname(join(to, path)), { recursive: true });
      cpSync(input, join(to, path), { recursive: true, dereference: true, filter: file => keepFile(file, from) });
    }
    if (pkg.license === 'MIT' && !existsSync(join(to, 'LICENSE'))) cpSync(join(source, 'LICENSE'), join(to, 'LICENSE'));
  } else {
    cpSync(from, to, { recursive: true, dereference: true, filter: file => keepFile(file, from) });
  }
  if (typeof pkg.main === 'string' && pkg.main.startsWith('lib/') && !existsSync(join(to, pkg.main))) throw new Error('Unbuilt runtime package: ' + pkg.name);
  installed.set(to, from);
  queue.push({ from, to, pkg });
  if (queue.length > 1200) throw new Error('Unexpected runtime dependency expansion');
  inventory.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? 'See package notices', path: relative(output, to).replaceAll('\\', '/') });
}
// Materialize the installed production dependency graph. Conflicting external
// versions stay beneath their consumer; shared Cordis/DSH packages stay singletons.
function provide(from, consumer) {
  const pkg = manifest(from);
  const top = join(modules, pkg.name);
  if (!installed.has(top)) { copyPackage(from, top); return; }
  if (pkg.name.startsWith('@deepseek-ai/') && installed.get(top) !== from) throw new Error('Multiple Harness package instances: ' + pkg.name);
  for (let directory = consumer; inside(directory, output); directory = dirname(directory)) {
    const nearest = installed.get(join(directory, 'node_modules', pkg.name));
    if (nearest === from) return;
    if (nearest) break;
    if (directory === output) break;
  }
  const nested = join(consumer, 'node_modules', pkg.name);
  if (installed.has(nested)) throw new Error('Conflicting nested dependency: ' + pkg.name);
  copyPackage(from, nested);
}

mkdirSync(modules, { recursive: true });
for (const seed of seeds) provide(realpathSync(join(source, seed)), output);
for (let index = 0; index < queue.length; index++) {
  const { from, to, pkg } = queue[index];
  const names = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]);
  for (const name of names) {
    const optional = name in (pkg.optionalDependencies ?? {}) || pkg.peerDependenciesMeta?.[name]?.optional;
    const dependency = findDependency(from, name);
    if (!dependency) { if (optional) continue; throw new Error('Missing installed dependency: ' + pkg.name + ' -> ' + name); }
    const target = manifest(dependency);
    if (!supported(target.os, process.platform) || !supported(target.cpu, process.arch)) {
      if (optional) continue;
      throw new Error('Unsupported required dependency: ' + name);
    }
    provide(dependency, to);
  }
}
writeFileSync(join(output, 'package.json'), JSON.stringify({ name: 'nexusroom-pc-runtime', version: release.version, private: true, type: 'module' }, null, 2) + '\n');
const licenses = inventory.map(pkg => `| ${pkg.name} | ${pkg.version} | ${String(pkg.license).replaceAll('|', '/')} | ${pkg.path} |`);
writeFileSync(join(output, 'THIRD_PARTY_LICENSES.md'), '# Harness production component licenses\n\nLicense and NOTICE texts remain inside each package. Paths below are relative to this runtime directory.\n\n| Package | Version | Declared license | Package directory |\n| --- | --- | --- | --- |\n' + licenses.join('\n') + '\n');
const files = [];
function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (lstatSync(path).isSymbolicLink()) throw new Error('Runtime contains a link: ' + path);
    if (entry.isDirectory()) inspect(path);
    else files.push({ path: relative(output, path).replaceAll('\\', '/'), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
  }
}
inspect(output);
writeFileSync(join(output, 'runtime-manifest.json'), JSON.stringify({ release: release.version, kernel: release.pcKernel, packages: inventory, files }, null, 2) + '\n');
console.log(`Packaged Harness ${upstream.version} (${commit.slice(0, 12)}): ${inventory.length} production packages, ${files.length} files, no links`);
