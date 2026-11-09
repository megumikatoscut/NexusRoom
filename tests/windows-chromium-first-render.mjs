import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

// This test adds a loopback-only CDP diagnostic port to the real fallback
// arguments. It deliberately does not use Playwright.launch() or --no-sandbox.
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = JSON.parse(await readFile(join(project, 'release.json'), 'utf8'));
const { windowsPayload } = await import('./windows-payload.mjs');
const packageRoot = resolve(process.argv[2] || windowsPayload(project, release.version));
const alternateChrome = process.argv[3];
assert.equal(JSON.parse(await readFile(join(packageRoot, 'release.json'), 'utf8')).version, release.version);
const evidence = await mkdtemp(join(tmpdir(), `nexusroom-v${release.version}-chromium-first-`));
const working = join(evidence, 'outside-project-working-directory');
const data = join(evidence, 'host-state');
const profile = join(data, 'browser-ui', 'profile');
await mkdir(working);
const ports = { ui: 18470, device: 18471, discovery: 18472, cdp: 18480 };
for (const port of [ports.ui, ports.device, ports.cdp]) {
  await new Promise((accept, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen({ port, host: '127.0.0.1', exclusive: true }, () => socket.close(accept));
  });
}
const environment = { ...process.env };
for (const key of Object.keys(environment)) if (/^(?:NEXUS(?:ROOM)?|DSH|NODE|PLAYWRIGHT|OPENAI|DEEPSEEK|ANTHROPIC)_/i.test(key) || key.toLowerCase() === 'path') delete environment[key];
const systemRoot = process.env.SystemRoot || process.env.windir;
const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
environment.PATH = [systemRoot, join(systemRoot, 'System32'), join(systemRoot, 'System32', 'Wbem'), dirname(powershell)].join(';');
const host = spawn(join(packageRoot, 'NexusRoom.Host.exe'), ['--headless'], {
  cwd: working, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...environment, NEXUS_DATA_DIR: data, NEXUS_UI_PORT: String(ports.ui), NEXUS_DEVICE_PORT: String(ports.device), NEXUS_DISCOVERY_PORT: String(ports.discovery), NEXUS_DISABLE_MDNS: '1' },
});
let hostDiagnostics = '';
for (const stream of [host.stdout, host.stderr]) stream.on('data', bytes => { hostDiagnostics = (hostDiagnostics + bytes).slice(-4000); });
const base = `http://127.0.0.1:${ports.ui}`;
const delay = ms => new Promise(accept => setTimeout(accept, ms));
let chrome;
let browser;
let chromeDiagnostics = '';
let page;
const failures = [];
const pageErrors = [];
const report = { version: release.version, freshProfile: true, noSandboxFlagUsed: false, hostVersion: null, dom: {}, requestFailures: failures, pageErrors, evidenceDirectory: evidence };
try {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    assert.equal(host.exitCode, null, 'isolated Host exited: ' + hostDiagnostics);
    try {
      const response = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) });
      const launchFile = await readFile(join(data, 'launch.dat'));
      if (response.ok && launchFile.length) { report.hostVersion = (await response.json()).version; break; }
    } catch { }
    await delay(100);
  }
  assert.equal(report.hostVersion, release.version, 'fresh Host startup/version failed');
  const launchPath = join(data, 'launch.dat').replaceAll("'", "''");
  const decrypt = `$ProgressPreference='SilentlyContinue'\nAdd-Type -AssemblyName System.Security\n[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes('${launchPath}'),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))`;
  const launchUrl = JSON.parse(execFileSync(powershell, ['-NoProfile', '-EncodedCommand', Buffer.from(decrypt, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true }).trim());
  const browserRoot = join(packageRoot, 'runtime', 'browsers');
  const chromiumDirectory = (await readdir(browserRoot)).find(name => name.startsWith('chromium-') && !name.startsWith('chromium_headless_shell-'));
  assert.ok(chromiumDirectory, 'the real bundled Chromium directory is missing');
  const executable = resolve(alternateChrome || join(browserRoot, chromiumDirectory, 'chrome-win64', 'chrome.exe'));
  report.chromiumExecutable = executable;
  const started = Date.now();
  chrome = spawn(executable, [
    '--app=' + launchUrl, '--user-data-dir=' + profile, '--window-size=1400,900',
    '--no-first-run', '--no-default-browser-check', '--disable-background-mode',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + ports.cdp,
  ], { cwd: working, windowsHide: false, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [chrome.stdout, chrome.stderr]) stream.on('data', bytes => {
    chromeDiagnostics = (chromeDiagnostics + bytes.toString('utf8')).replace(/#bootstrap=[a-f0-9]+/gi, '#bootstrap=<redacted>').slice(-12000);
  });
  const require = createRequire(join(packageRoot, 'runtime', 'harness', 'package.json'));
  const { chromium } = require('playwright-core');
  const connectionDeadline = Date.now() + 45000;
  while (Date.now() < connectionDeadline) {
    assert.equal(chrome.exitCode, null, 'fresh Chromium exited before its debug endpoint');
    try {
      const endpoint = /DevTools listening on (ws:\/\/127\.0\.0\.1:[^\r\n]+)/.exec(chromeDiagnostics)?.[1];
      if (!endpoint) { await delay(100); continue; }
      browser = await chromium.connectOverCDP(endpoint, { timeout: 30000 }); break;
    } catch (error) { report.cdpConnectionError = error.message.slice(0, 2000); await delay(100); }
  }
  assert.ok(browser, 'fresh Chromium CDP endpoint did not appear');
  const context = browser.contexts()[0];
  page = context.pages().find(candidate => candidate.url().startsWith(base)) || context.pages()[0];
  if (!page) page = await context.waitForEvent('page', { timeout: 5000 });
  page.on('requestfailed', request => {
    let path; try { path = new URL(request.url()).pathname; } catch { path = '<invalid-url>'; }
    failures.push({ path, failure: request.failure()?.errorText || '' });
  });
  page.on('pageerror', error => pageErrors.push(error.name + ': ' + error.message.slice(0, 300)));
  const renderDeadline = Date.now() + 45000;
  while (Date.now() < renderDeadline) {
    const text = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
    report.dom = { version: text.includes('NexusRoom v' + release.version), roomOverview: text.includes('房间总览'), localService: text.includes('本地服务运行中'), roomContent: text.includes('房间设备') && !text.includes('正在连接本地工作空间') };
    if (Object.values(report.dom).every(Boolean)) { report.firstRenderMilliseconds = Date.now() - started; break; }
    await delay(250);
  }
  report.currentPath = new URL(page.url()).pathname;
  report.title = await page.title();
  report.chromeStderr = chromeDiagnostics;
  await page.screenshot({ path: join(evidence, 'fresh-chromium-page.png'), fullPage: true });
  report.firstRenderPassed = Object.values(report.dom).every(Boolean);
  assert.ok(report.firstRenderPassed, 'fresh Chromium did not render the release/room/service DOM markers within 45 seconds');
  console.log(`PASS fresh bundled Chromium ${release.version}: no --no-sandbox; real app parameters; DOM release/room/service and populated room rendered in ${report.firstRenderMilliseconds} ms; no restart`);
} finally {
  report.chromeStderr = chromeDiagnostics;
  await writeFile(join(evidence, 'first-render.json'), JSON.stringify(report, null, 2) + '\n');
  if (browser) await browser.close().catch(() => {});
  if (chrome && chrome.exitCode === null) {
    // The PID is the exact still-owned spawned browser, never an image-name match.
    const taskkill = join(systemRoot, 'System32', 'taskkill.exe');
    try { execFileSync(taskkill, ['/PID', String(chrome.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { }
  }
  if (host.exitCode === null) host.kill();
  await delay(500);
  console.log('Isolated first-render report: ' + join(evidence, 'first-render.json'));
}
