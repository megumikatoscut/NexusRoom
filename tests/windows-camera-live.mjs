import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { chromium } from 'playwright';

// Opt-in real-camera acceptance through the compiled inner or single EXE.
// No fake devices, permission pregrants, image files or saved camera pixels.
const executable = process.env.NEXUS_TEST_HOST;
assert.ok(executable, 'Set NEXUS_TEST_HOST to the compiled Windows EXE');
const root = resolve(import.meta.dirname, '..');
const data = process.env.NEXUS_CAMERA_DATA || join(root, '.local', `camera-live-${Date.now()}`);
const port = Number(process.env.NEXUS_CAMERA_PORT || 19790);
await mkdir(data, { recursive: true });
const child = spawn(executable, [], { cwd: dirname(executable), windowsHide: false, stdio: 'ignore', env: {
  ...process.env, NEXUS_DATA_DIR: data, NEXUS_UI_PORT: String(port), NEXUS_DEVICE_PORT: String(port + 1),
  NEXUS_DISCOVERY_PORT: String(port + 2), NEXUS_DISABLE_MDNS: '1',
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port + 4}`,
} });
let browser, helper, hostPid = child.pid;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(action, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await action()) return; await pause(150); }
  throw new Error(message);
}
try {
  await until(() => fetch(`http://127.0.0.1:${port + 4}/json/version`).then(r => r.ok).catch(() => false), 'Desktop debugging endpoint did not start', 120000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port + 4}`);
  const page = browser.contexts().flatMap(c => c.pages())[0];
  hostPid = Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `$all=Get-CimInstance Win32_Process; $ids=@(${child.pid}); for($i=0;$i -lt 4;$i++){$ids+=@($all|Where-Object {$_.ParentProcessId -in $ids}|Select-Object -ExpandProperty ProcessId)}; $all|Where-Object {$_.ProcessId -in $ids -and $_.Name -eq 'NexusRoom.Host.exe'}|Select-Object -First 1 -ExpandProperty ProcessId`], { encoding: 'utf8', windowsHide: true }).trim());
  assert.ok(hostPid, 'Could not find the isolated desktop Host process');
  helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(root, 'tests/fixtures/ApproveCommunicationMedia.ps1'), '-HostProcessId', String(hostPid)], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, NEXUS_MEDIA_INITIAL_DENIALS: '1' } });
  helper.stderr.on('data', bytes => { if (process.env.NEXUS_CAMERA_DEBUG === '1') console.log(bytes.toString().trim()); });
  await page.getByRole('button', { name: '通话与会议', exact: true }).click();
  await page.getByRole('button', { name: '创建会议', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '创建会议', exact: true }).click();
  await page.getByRole('button', { name: '开启摄像头', exact: true }).waitFor();
  assert.equal(await page.evaluate(async () => (await (await fetch('/api/communication/camera/capability')).json()).supported), true);
  await page.evaluate(() => {
    window.qaCameraTracks = []; window.qaCameraSockets = [];
    const capture = HTMLCanvasElement.prototype.captureStream;
    HTMLCanvasElement.prototype.captureStream = function(...args) { const stream = capture.apply(this, args); window.qaCameraTracks.push(...stream.getVideoTracks()); return stream; };
    const Socket = window.WebSocket;
    window.qaCameraDiagnostics = [];
    window.WebSocket = class extends Socket { constructor(...args) { super(...args); if (String(args[0]).includes('/camera/ws?')) { window.qaCameraSockets.push(this); this.addEventListener('message', e => { if (typeof e.data === 'string') window.qaCameraDiagnostics.push(e.data); }); this.addEventListener('close', e => window.qaCameraDiagnostics.push({ code: e.code, reason: e.reason })); } } };
  });
  await page.getByRole('button', { name: '开启摄像头', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '摄像头权限未获批准' }).waitFor();
  assert.equal(await page.evaluate(() => window.qaCameraTracks.length), 0);
  await until(() => page.evaluate(() => window.qaCameraSockets.every(s => s.readyState === WebSocket.CLOSED)), 'Denied camera connection did not close');
  await page.getByRole('button', { name: '开启摄像头', exact: true }).click();
  await until(async () => await page.getByRole('button', { name: '关闭摄像头', exact: true }).isVisible() || await page.getByRole('alert').count(), 'Camera did not settle after consent', 35000);
  assert.equal(await page.getByRole('alert').count(), 0, (await page.getByRole('alert').allTextContents()).join(' '));
  const video = page.locator('.participant-camera video').first();
  await until(() => video.evaluate(v => v.videoWidth > 0 && v.getVideoPlaybackQuality().totalVideoFrames > 10), 'Physical camera did not deliver frames');
  console.log('FRAMES', await video.evaluate(v => ({ width: v.videoWidth, height: v.videoHeight, decoded: v.getVideoPlaybackQuality().totalVideoFrames })));
  await page.getByRole('button', { name: '关闭摄像头', exact: true }).click();
  await until(() => page.evaluate(() => window.qaCameraTracks.every(t => t.readyState === 'ended')), 'Camera did not release after disabling');
  await until(() => page.evaluate(() => window.qaCameraSockets.every(s => s.readyState === WebSocket.CLOSED)), 'Native camera connection did not close after disabling');
  await page.getByRole('button', { name: '开启摄像头', exact: true }).click();
  await until(async () => await page.getByRole('button', { name: '关闭摄像头', exact: true }).isVisible() || await page.getByRole('alert').count(), 'Camera did not settle after reopening', 35000);
  assert.equal(await page.getByRole('alert').count(), 0, (await page.getByRole('alert').allTextContents()).join(' '));
  await until(() => video.evaluate(v => v.videoWidth > 0 && v.getVideoPlaybackQuality().totalVideoFrames > 10), 'Camera did not reopen');
  await page.getByRole('button', { name: '结束会议', exact: true }).click();
  await until(() => page.evaluate(() => window.qaCameraTracks.every(t => t.readyState === 'ended')), 'Camera did not release on meeting exit');
  await until(() => page.evaluate(() => window.qaCameraSockets.every(s => s.readyState === WebSocket.CLOSED)), 'Native camera connection did not close on meeting exit');
  console.log('PASS physical camera denial, consent, frames, disable, reopen and meeting cleanup');
} finally {
  if (browser && process.env.NEXUS_CAMERA_DEBUG === '1') { const page = browser.contexts().flatMap(c => c.pages())[0]; console.log('CAMERA_DIAGNOSTICS', await page?.evaluate(() => window.qaCameraDiagnostics).catch(() => undefined)); }
  if (helper) { try { execFileSync('taskkill', ['/PID', String(helper.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} }
  await browser?.close().catch(() => {});
  try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `$p=Get-Process -Id ${hostPid} -ErrorAction SilentlyContinue; if($p){[void]$p.CloseMainWindow(); [void]$p.WaitForExit(6000)}`], { windowsHide: true, stdio: 'ignore' }); } catch {}
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
}
