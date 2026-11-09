import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, lstatSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { join, relative, resolve, sep, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const packageIndex = args.indexOf('--package');
if (packageIndex < 0 || !args[packageIndex + 1]) throw new Error('Usage: node verify-release.mjs --package <directory>');
const root = resolve(args[packageIndex + 1]);
if (!args.includes('--inventory-only') && !process.execArgv.includes('--preserve-symlinks')) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  execFileSync(join(root, 'runtime', 'node', 'node.exe'), ['--preserve-symlinks', '--preserve-symlinks-main', fileURLToPath(import.meta.url), ...args], { stdio: 'inherit', windowsHide: true, env });
  process.exit(0);
}
const release = JSON.parse(readFileSync(new URL('../release.json', import.meta.url), 'utf8'));
const documents = JSON.parse(readFileSync(new URL('./release-documents.json', import.meta.url), 'utf8'));
const excludedDocs = new Set(['PC_AGENT.md', 'VALIDATION.md', 'PROJECT_STRUCTURE.md']);
const historicalDocuments = args.includes('--allow-historical-documents');
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
assert.deepEqual(JSON.parse(readFileSync(join(root, 'release.json'), 'utf8')), release, 'release metadata mismatch');
let harness = join(root, 'runtime', 'harness');
const manifestPath = join(harness, 'runtime-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
let primaryRoot = join(root, 'runtime', 'primary-runtime');
const primary = JSON.parse(readFileSync(join(primaryRoot, 'runtime.json'), 'utf8'));
assert.equal(primary.payloadDigest, release.pcKernel.primaryRuntime.payloadDigest, 'primary runtime identity mismatch');
assert.equal(primary.platform, 'win32', 'primary runtime platform mismatch');
assert.equal(primary.arch, 'x64', 'primary runtime architecture mismatch');
for (const name of ['python', 'node', 'pnpm']) assert.equal(primary[name], release.pcKernel.primaryRuntime[name]);
const fail = message => { throw new Error('Release verification failed: ' + message); };
const requireFile = path => { if (!existsSync(path)) fail('missing ' + relative(root, path)); return path; };
for (const file of release.vcRuntime.files) {
  const path = requireFile(join(root, 'runtime', 'node', file.name));
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), file.sha256, 'app-local Visual C++ DLL identity mismatch: ' + file.name);
}

assert.equal(manifest.release, release.version, 'Harness manifest release mismatch');
assert.deepEqual(manifest.kernel, release.pcKernel, 'Harness kernel metadata mismatch');
const packageNames = new Set(manifest.packages.map(item => item.name));
for (const name of [
  '@deepseek-ai/dsh', '@deepseek-ai/dsh-sdk-app', '@deepseek-ai/dsh-sdk-jsonrpc-server',
  '@deepseek-ai/dsh-computer-use', '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native',
  '@deepseek-ai/dsh-browser-use', '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp',
  '@trycua/cua-driver', '@playwright/mcp', 'playwright-core',
  '@deepseek-ai/dsh-skill-office', '@deepseek-ai/dsh-tool-workspace-dependencies',
  '@deepseek-ai/dsh-workspace', '@deepseek-ai/libreoffice-kit-win32-x64',
]) assert.ok(packageNames.has(name), `required Harness plugin missing: ${name}`);

const listed = new Map(manifest.files.map(item => [item.path, item.sha256]));
if (listed.size !== manifest.files.length) fail('duplicate runtime manifest paths');
for (const file of manifest.files) {
  const path = resolve(harness, file.path);
  if (!path.startsWith(harness + sep)) fail('manifest path outside Harness');
  requireFile(path);
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (digest !== file.sha256) fail('runtime digest mismatch: ' + file.path);
}
const walk = directory => {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (lstatSync(path).isSymbolicLink()) fail('symbolic link shipped: ' + relative(root, path));
    if (entry.isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
};
const allFiles = walk(root);
for (const path of allFiles) {
  const name = relative(root, path).replaceAll('\\', '/');
  if (name.includes('/.git/') || name.endsWith('/.git') || name.split('/').some(part => part === '.env' || part.startsWith('.env.')))
    fail('source metadata or environment file shipped: ' + name);
  if (/(?:^|\/)(?:state|launch|password|certificate)\.dat$/i.test(name) || /\.(?:pfx|jks|keystore|key)$/i.test(name)
    || /(?:^|\/)(?:audit\.jsonl(?:\.previous)?|\.credentials\.ya?ml|\.anonymous-user-id)$/i.test(name))
    fail('credential or persisted state shipped: ' + name);
  if (name.split('/').some(part => ['.git', '.history', '.local', '.dsh', 'webview', 'browser-ui', 'session-data'].includes(part)))
    fail('user history directory shipped: ' + name);
  if (name.startsWith('docs/archive/') || (name.startsWith('docs/') && excludedDocs.has(name.slice(5))))
    fail('historical validation document shipped: ' + name);
  if (name.startsWith('runtime/browsers/') && (
    /\.(?:log|dmp)$/i.test(name)
    || /(?:^|\/)(?:Crashpad|BrowserMetrics|User Data|Default|Profile(?: \d+)?|Cache|Code Cache|GPUCache|Storage|History|Cookies|Preferences|Singleton[^/]*)(?:\/|$)/i.test(name)
  )) fail('browser history or diagnostic file shipped: ' + name);
  if (path.startsWith(harness + sep) && path !== manifestPath && !listed.has(relative(harness, path).replaceAll('\\', '/')))
    fail('unlisted runtime file: ' + name);
}
for (const path of [
  join(root, 'runtime', 'node', 'node.exe'), join(root, 'runtime', 'node', 'LICENSE'),
  join(root, 'runtime', 'browsers'), join(root, 'NexusRoom.Host.exe'), join(root, 'release.json'),
  join(root, 'System.Private.CoreLib.dll'), join(root, 'wwwroot', 'index.html'),
  join(root, 'Agent', 'harness-sdk.patch.yml'), join(root, 'Agent', 'harness-approval.mjs'), join(root, 'Agent', 'harness-limits.mjs'), join(root, 'Agent', 'harness-room-files.mjs'),
  join(root, 'Agent', 'harness-runtime-path.mjs'),
  join(root, 'tools', 'NexusRoom-Android.apk'),
  join(primaryRoot, 'dependencies', 'python', 'python.exe'), join(primaryRoot, 'dependencies', 'node', 'bin', 'node.exe'),
  join(primaryRoot, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
]) requireFile(path);
const powershell = join(process.env.SystemRoot || process.env.windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const binaryVersionsScript = `@{exe=(Get-Item -LiteralPath '${join(root, 'NexusRoom.Host.exe').replaceAll("'", "''")}').VersionInfo.FileVersion;dll=(Get-Item -LiteralPath '${requireFile(join(root, 'NexusRoom.Host.dll')).replaceAll("'", "''")}').VersionInfo.FileVersion}|ConvertTo-Json -Compress`;
const binaryVersions = JSON.parse(execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(binaryVersionsScript, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true }).trim());
for (const kind of ['exe', 'dll']) assert.equal(binaryVersions[kind], release.version + '.0', 'Host ' + kind + ' file version mismatch');
const chromium = allFiles.filter(path => /chromium.*\.exe$/i.test(path) || /chrome-win.*[\\/]chrome\.exe$/i.test(path));
if (chromium.length === 0) fail('bundled Chromium executable is missing');
const docs = readdirSync(join(root, 'docs'), { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name);
const approvedDocs = new Set(documents.docs.map(name => name.replaceAll('{version}', release.version)).filter(name => !excludedDocs.has(name)));
for (const name of docs) if (!historicalDocuments && !approvedDocs.has(name)) fail('unapproved document shipped: docs/' + name);
for (const name of approvedDocs) {
  const path = requireFile(join(root, 'docs', name));
  const documentSource=name==='THIRD_PARTY_NOTICES.md'?join(sourceRoot,'scripts/templates/windows/THIRD_PARTY_NOTICES.md'):join(sourceRoot,'docs',name);
  if (!historicalDocuments) assert.ok(readFileSync(path).equals(readFileSync(documentSource)), 'Embedded document differs from current runtime template: docs/' + name);
}
for (const name of documents.root) {
  const path = requireFile(join(root, name));
  const source = name.startsWith('README.') ? join(sourceRoot, 'scripts', 'templates', 'windows', name) : join(sourceRoot, name);
  if (!historicalDocuments) assert.ok(readFileSync(path).equals(readFileSync(source)), 'Embedded document differs from current source: ' + name);
}
const assets = allFiles.filter(path => /wwwroot[\\/]assets[\\/]index-[^\\/]+\.js$/.test(path));
assert.ok(assets.some(path => readFileSync(path, 'utf8').includes(release.version)), 'Web UI release version is missing');
const voiceModels = JSON.parse(readFileSync(join(sourceRoot, 'config', 'voice-models.json'), 'utf8'));
for (const entry of voiceModels.models) {
  const file = requireFile(join(root, 'voice', entry.target));
  const content = readFileSync(file);
  assert.equal(content.length, entry.bytes, 'voice model size mismatch: ' + entry.target);
  assert.equal(createHash('sha256').update(content).digest('hex'), entry.sha256, 'voice model identity mismatch: ' + entry.target);
}
assert.equal(readFileSync(requireFile(join(root, 'voice', 'kws', 'keywords.txt')), 'utf8').trim(), voiceModels.wakeTokens, 'wake keyword definition mismatch');
requireFile(join(root, 'sherpa-onnx.dll'));
assert.ok(allFiles.some(path => /[\\/]sherpa-onnx-c-api\.dll$/i.test(path)), 'Windows Sherpa native runtime is missing');
requireFile(join(root, 'docs', 'licenses', 'sherpa-onnx-LICENSE.txt'));
requireFile(join(root, 'docs', 'licenses', 'ONNX-Runtime-LICENSE.txt'));
if (args.includes('--inventory-only')) {
  console.log(`PASS release ${release.version} inventory: ${allFiles.length} files; ${manifest.files.length} verified Harness digests; clean state and current documents`);
  process.exit(0);
}

const temp = mkdtempSync(join(tmpdir(), 'nexusroom-release-verify-'));
const { ensureRuntimePath } = await import(pathToFileURL(join(root, 'Agent', 'harness-runtime-path.mjs')).href);
const runtimePath = ensureRuntimePath(join(root, 'runtime'));
harness = join(runtimePath, 'harness');
primaryRoot = join(runtimePath, 'primary-runtime');
const patchPath = join(temp, 'profile.patch.yml');
const hostAgent = join(root, 'Agent');
const yamlPath = path => path.replaceAll('\\', '/').replaceAll("'", "''");
// The SDK protocol exposes initialize/prompt/shutdown, without tools/list.
// Activate the exact bundled room plugin in the real Cordis tool service and
// capture its registered schemas through a temporary verification wrapper.
const roomFilesModule = pathToFileURL(join(hostAgent, 'harness-room-files.mjs')).href;
const roomToolsPath = join(temp, 'room-tools.json');
const roomProbePlugin = join(temp, 'room-files-probe.mjs');
writeFileSync(roomProbePlugin, `import { writeFileSync } from 'node:fs';\nimport { apply as activate } from ${JSON.stringify(roomFilesModule)};\nexport { name, inject } from ${JSON.stringify(roomFilesModule)};\nexport function apply(ctx, config) { const result = activate(ctx, config); writeFileSync(${JSON.stringify(roomToolsPath)}, JSON.stringify(ctx.tools.schemas())); return result; }\n`);
let patch = readFileSync(join(hostAgent, 'harness-sdk.patch.yml'), 'utf8');
patch = patch.replaceAll('../../../third_party/deepseek-harness/', yamlPath(harness) + '/');
for (const [source, packageName] of [
  ['packages/computer-use/computer-use', 'dsh-computer-use'],
  ['packages/experimental/computer-use-cua-driver-native', 'dsh-experimental-computer-use-cua-driver-native'],
  ['packages/browser-use/browser-use', 'dsh-browser-use'],
  ['packages/experimental/browser-use-playwright-mcp', 'dsh-experimental-browser-use-playwright-mcp'],
]) patch = patch.replaceAll(source + '/lib/index.js', 'node_modules/@deepseek-ai/' + packageName + '/lib/index.js');
patch = patch.replaceAll('__NEXUSROOM_APPROVAL_PLUGIN__', yamlPath(join(hostAgent, 'harness-approval.mjs')));
patch = patch.replaceAll('__NEXUSROOM_LIMITS_PLUGIN__', yamlPath(join(hostAgent, 'harness-limits.mjs')));
patch = patch.replaceAll('__NEXUSROOM_ROOM_FILES_PLUGIN__', yamlPath(roomProbePlugin));
writeFileSync(patchPath, patch);
const node = join(root, 'runtime', 'node', 'node.exe');
assert.equal(execFileSync(node, ['--version'], { encoding: 'utf8', windowsHide: true }).trim(), 'v' + release.pcKernel.nodeVersion);
const bin = join(harness, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const environment = { ...process.env };
const inheritedPath = process.env.PATH || process.env.Path || '';
for (const name of Object.keys(environment)) if (name.toLowerCase() === 'path') delete environment[name];
environment.PATH = join(root, 'runtime', 'node') + delimiter + inheritedPath;
environment.PYTHONDONTWRITEBYTECODE = '1';
process.env.PYTHONDONTWRITEBYTECODE = '1';
delete environment.NODE_PATH;
delete environment.NODE_OPTIONS;
environment.NODE_OPTIONS = '--preserve-symlinks --preserve-symlinks-main';
delete environment.DSH_PRIMARY_RUNTIME;
delete environment.DSH_BUNDLED_PRIMARY_RUNTIME;
const child = spawn(node, ['--preserve-symlinks', '--preserve-symlinks-main', bin, '--profile', 'sdk', '--patch', patchPath], {
  cwd: temp,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...environment,
    DSH_HOME: join(temp, 'dsh-home'),
    DSH_TELEMETRY_DISABLED: '1',
    DSH_BUNDLED_PRIMARY_RUNTIME: primaryRoot,
    NEXUSROOM_HARNESS_API: 'openai-completions',
    NEXUSROOM_HARNESS_BASE_URL: 'https://api.openai.com/v1',
    NEXUSROOM_HARNESS_MODEL: 'release-verification',
    NEXUSROOM_HARNESS_API_KEY: 'release-verification-only',
    DSH_PERMISSION_MODE: 'workspace-write',
    NEXUSROOM_APPROVAL_PIPE: '',
    NEXUSROOM_ROOM_FILES_PIPE: 'NexusRoom-RoomFiles-' + '0'.repeat(32),
    PLAYWRIGHT_BROWSERS_PATH: join(root, 'runtime', 'browsers'),
  },
});
let stdout = '';
let stderr = '';
child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
const lines = [];
let pendingLine = '';
let processError;
child.on('error', error => { processError = error; });
const exited = new Promise(resolvePromise => child.once('exit', resolvePromise));
const waitFor = (id, timeout = 60000) => new Promise((resolvePromise, reject) => {
  const deadline = Date.now() + timeout;
  const timer = setInterval(() => {
    for (let index = 0; index < lines.length; index++) {
      let value;
      try { value = JSON.parse(lines[index]); } catch { continue; }
      if (value.id === id) { lines.splice(0, index + 1); clearInterval(timer); resolvePromise(value); return; }
    }
    if (processError || child.exitCode !== null || Date.now() > deadline) {
      clearInterval(timer); reject(new Error('Harness protocol failed: ' + (processError?.message || stderr || stdout).slice(-3000)));
    }
  }, 25);
});
child.stdout.on('data', chunk => {
  pendingLine += chunk.toString('utf8');
  const frames = pendingLine.split(/\r?\n/);
  pendingLine = frames.pop();
  lines.push(...frames.filter(line => line.trim()));
});
const send = (id, method, params = {}) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
const freePort = () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolvePort(port)); });
});
async function verifyPackagedHost() {
  const ports = new Set();
  while (ports.size < 3) ports.add(await freePort());
  const [uiPort, devicePort, discoveryPort] = ports;
  const data = join(temp, 'host-state');
  const hostEnvironment = { ...environment, NEXUS_DATA_DIR: data, NEXUS_UI_PORT: String(uiPort), NEXUS_DEVICE_PORT: String(devicePort), NEXUS_DISCOVERY_PORT: String(discoveryPort), NEXUS_DISABLE_MDNS: '1', NEXUS_ANDROID_APK: join(root, 'tools', 'NexusRoom-Android.apk') };
  const host = spawn(join(root, 'NexusRoom.Host.exe'), ['--headless'], { cwd: root, env: hostEnvironment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  let startupError;
  host.once('error', error => { startupError = error; });
  for (const stream of [host.stdout, host.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk.toString('utf8')).slice(-4000); });
  const closed = new Promise(resolveClosed => host.once('close', resolveClosed));
  const base = `http://127.0.0.1:${uiPort}`;
  try {
    let healthy = false;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (startupError || host.exitCode !== null) fail('packaged Host startup failed: ' + (startupError?.message || diagnostics));
      try {
        const response = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) });
        if (response.ok && existsSync(join(data, 'launch.dat'))) { assert.equal((await response.json()).version, release.version); healthy = true; break; }
      } catch { }
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    if (!healthy) fail('packaged Host did not start: ' + diagnostics);
    const launchFile = join(data, 'launch.dat').replaceAll("'", "''");
    const script = `Add-Type -AssemblyName System.Security\n[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes('${launchFile}'),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))`;
    const launch = JSON.parse(execFileSync(powershell, ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true }).trim());
    const token = new URL(launch).hash.substring('#bootstrap='.length);
    const api = async path => {
      const response = await fetch(base + path, { headers: { Authorization: `Bearer ${token}`, 'X-Nexus-Request': '1' } });
      assert.equal(response.status, 200, 'packaged Host API failed: ' + path);
      return response.json();
    };
    const state = await api('/api/state');
    assert.equal(state.rooms.length, 1, 'fresh release must have only its new default room');
    for (const name of ['devices', 'transfers', 'approvals']) assert.deepEqual(state[name], [], 'fresh release has persisted ' + name);
    for (const name of ['active', 'pending']) assert.deepEqual(state.media[name], [], 'fresh release has media sessions');
    assert.equal(state.host.ownerRoom, '');
    assert.equal(state.host.remote.session, null);
    assert.ok(Object.values(state.host.remote.permissions).every(value => value === false), 'fresh release has remote permissions');
    assert.deepEqual(await api('/api/agent/runs'), [], 'fresh release has persisted tasks');
    const settings = await api('/api/settings');
    assert.equal(settings.hasKey, false);
    assert.equal(settings.model, '');
    assert.equal(settings.hasExternalToken, false);
    assert.deepEqual(settings.sharedFolders, [], 'fresh release has shared folders');
    assert.equal(settings.profiles.length, 1, 'fresh release must have only its new default model profile');
    assert.ok(settings.profiles.every(profile => !profile.hasKey && profile.model === ''), 'fresh release has model credentials');
    const voiceStatus = await api('/api/voice/status');
    assert.equal(voiceStatus.enabled, false, 'fresh release must not open the microphone');
    assert.equal(voiceStatus.wakeEnabled, false, 'fresh release must not start automatic wake');
    assert.equal(voiceStatus.ready, true, 'fresh release lacks offline voice models');
    assert.deepEqual(await api('/api/voice/tasks'), [], 'fresh release has persisted voice tasks');
    const communication = await api('/api/communication/state');
    assert.equal(communication.activeSessionId, '');
    for (const name of ['sessions', 'invitations']) assert.deepEqual(communication[name], [], 'fresh release has communication history');
    assert.equal(communication.devices.length, 1);
    assert.equal(communication.devices[0].id, communication.selfId);
    assert.equal(communication.devices[0].communicationOnline, false);
    assert.equal(communication.devices[0].busy, false);
    const apk = await fetch(base + '/api/android-apk', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(apk.status, 200, 'packaged Android download is missing');
    await apk.body.cancel();
  } finally {
    if (host.exitCode === null) host.kill();
    await closed;
  }
}
try {
  send('verify-initialize', 'initialize', { cwd: temp, provider: 'nexusroom', model: 'release-verification' });
  const initialized = await waitFor('verify-initialize');
  if (initialized.error) fail('bundled Harness initialize failed: ' + JSON.stringify(initialized.error));
  const roomTools = JSON.parse(readFileSync(roomToolsPath, 'utf8'));
  for (const name of ['list_room_devices', 'send_file_to_phone', 'arrange_communication']) assert.ok(roomTools.some(tool => tool.name === name), 'bundled Harness room tool missing: ' + name);
  assert.deepEqual(roomTools.find(tool => tool.name === 'send_file_to_phone').parameters.required, ['path'], 'bundled room-file path schema mismatch');
  send('verify-shutdown', 'shutdown');
  const stopped = await waitFor('verify-shutdown');
  if (stopped.error) fail('bundled Harness shutdown failed: ' + JSON.stringify(stopped.error));
  const exitTimeout = setTimeout(() => child.kill(), 10000);
  await exited;
  clearTimeout(exitTimeout);
  if (child.exitCode !== 0) fail('bundled Harness exited ' + child.exitCode + ': ' + stderr.slice(-3000));
  const require = createRequire(join(harness, 'package.json'));
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(runtimePath, 'browsers');
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<title>NexusRoom release verification</title><h1>PACKAGED_BROWSER_OK</h1>');
    assert.equal(await page.locator('h1').textContent(), 'PACKAGED_BROWSER_OK');
  } finally { await browser.close(); }
  const cuaRoot = join(harness, 'node_modules', '@trycua', 'cua-driver');
  const cuaManifest = JSON.parse(readFileSync(join(cuaRoot, 'package.json'), 'utf8'));
  const { CuaDriver } = await import(pathToFileURL(join(cuaRoot, cuaManifest.exports['.'].import)).href);
  const driver = CuaDriver.create(undefined);
  try {
    const catalog = JSON.parse(await driver.listToolsJson());
    assert.ok(catalog.tools.some(tool => tool.name === 'list_windows'), 'Cua window tool missing');
    const permissions = JSON.parse((await driver.callTool('check_permissions', JSON.stringify({ prompt: false }))).rawJson);
    assert.ok(!permissions.isError, 'Cua permissions check failed');
    const windows = JSON.parse((await driver.callTool('list_windows', '{}')).rawJson);
    assert.ok(!windows.isError, 'Cua window enumeration failed');
  } finally { await driver.shutdown(); driver.uniffiDestroy(); }
  const primaryPython = join(primaryRoot, 'dependencies', 'python', 'python.exe');
  const officeInput = join(temp, 'office-verification.docx');
  const pythonVersion = execFileSync(primaryPython, ['-I', '-B', '-c', 'import sys, numpy, pandas, docx, pptx, openpyxl, PIL, lxml, xlsxwriter; document=docx.Document(); document.add_paragraph("NexusRoom packaged Office verification"); document.save(sys.argv[1]); print(".".join(map(str, sys.version_info[:3])))', officeInput], { encoding: 'utf8', windowsHide: true }).trim();
  assert.equal(pythonVersion, primary.python, 'bundled Python or document libraries failed');
  const primaryNode = join(primaryRoot, 'dependencies', 'node', 'bin', 'node.exe');
  assert.equal(execFileSync(primaryNode, ['--version'], { encoding: 'utf8', windowsHide: true }).trim(), 'v' + primary.node);
  assert.equal(execFileSync(primaryNode, [join(primaryRoot, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'), '--version'], { encoding: 'utf8', windowsHide: true }).trim(), primary.pnpm);
  process.env.PATH = environment.PATH;
  const { createConverter } = await import(pathToFileURL(join(harness, 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'index.js')).href);
  const converter = await createConverter({ timeoutMs: 60000, fontMetadataCacheDirectory: false });
  const officeOutput = join(temp, 'office-verification.pdf');
  try {
    const converted = await converter.render({ inputPath: officeInput, outputPath: officeOutput });
    assert.equal(converted.backend, 'native', 'bundled LibreOffice native backend did not run');
    assert.equal(readFileSync(officeOutput).subarray(0, 5).toString('ascii'), '%PDF-', 'bundled Office conversion did not produce a PDF');
  } finally { await converter.dispose(); }
  const officeCliOutput = join(temp, 'office-cli-verification.pdf');
  const officeCliResult = JSON.parse(execFileSync(primaryNode, [join(harness, 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js'), 'convert', '--input', officeInput, '--output', officeCliOutput], { env: environment, encoding: 'utf8', windowsHide: true, timeout: 90000 }).trim());
  assert.equal(officeCliResult.backend, 'native', 'Office skill CLI did not use the bundled native backend');
  assert.equal(readFileSync(officeCliOutput).subarray(0, 5).toString('ascii'), '%PDF-', 'Office skill CLI subprocess did not produce a PDF');
  await verifyPackagedHost();
} finally {
  if (!child.killed && child.exitCode === null) child.kill();
  assert.ok(temp.startsWith(tmpdir() + sep), 'verification cleanup must remain under temporary directory');
  rmSync(temp, { recursive: true, force: true });
}
console.log(`PASS release ${release.version}: ${manifest.packages.length} Harness packages, ${manifest.files.length} verified files; SDK room tools, Chromium, native Cua, Python/Node/pnpm, native Office API and skill CLI-to-PDF and fresh packaged Host`);
