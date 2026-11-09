import { projectPath, generatedEvidencePath } from '../scripts/submission-paths.mjs';
// Opt-in real Android Agent validation. Debug APK setup reads the temporary
// handshake written outside the repository; the provider key stays on the Host.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const key = process.env.NEXUS_TEST_MODEL_KEY; assert.ok(key, 'Explicitly authorized model key required');
const data = await mkdtemp(resolve(tmpdir(), 'NexusRoom-voice-android-'));
const handshake = resolve(process.env.USERPROFILE, '.cache/NexusRoom/build-cache/v1.0.0/android-voice-handshake.json');
const ui = 18890; let child, admin, room, runId;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(check, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return; await wait(300); } throw new Error('Android voice fixture timeout'); }
function launch() { const path = resolve(data, 'launch.dat').replaceAll("'", "''"); return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes('${path}'),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))`], { encoding: 'utf8', windowsHide: true }).trim()); }
async function api(path, body, method = body === undefined ? 'GET' : 'POST') { const r = await fetch(`http://127.0.0.1:${ui}${path}`, { method, headers: { Authorization: `Bearer ${admin}`, 'X-Nexus-Request': '1', 'X-Nexus-Room': room || '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); const value = await r.json(); assert.equal(r.status, 200, value.title || 'Host request failed'); return value; }
try {
  const env = { ...process.env, NEXUS_DATA_DIR: data, NEXUS_UI_PORT: '' + ui, NEXUS_DEVICE_PORT: '18891', NEXUS_DISCOVERY_PORT: '18892', NEXUS_DISABLE_MDNS: '1' }; delete env.NEXUS_TEST_MODEL_KEY;
  child = spawn('dotnet', [projectPath(root, 'src/NexusRoom.Host/bin/Debug/net10.0-windows/NexusRoom.Host.dll'), '--headless'], { windowsHide: true, env, stdio: 'ignore' });
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${ui}/health`)).ok; } catch { return false; } });
  admin = new URL(launch()).hash.split('=')[1]; const invitation = await api('/api/invitation'); room = invitation.roomId;
  const profile = await api('/api/settings/profiles', { name: 'Authorized ephemeral Android validation', apiType: 'chat_completions', apiUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash', apiKey: key, maxCalls: 6, maxSteps: 6, timeoutSeconds: 120 });
  await writeFile(handshake, JSON.stringify({ server: 'https://10.0.2.2:18891', roomId: room, password: invitation.password, fingerprint: invitation.fingerprint }));
  console.log('Isolated Host ready for debug Android setup; temporary handshake prepared outside source');
  let phone;
  await until(async () => { phone = (await api('/api/state')).devices.find(d => d.online && d.permissions.agent); return !!phone; }, 180000);
  const eventId = randomUUID(); const wake = await api('/api/voice/wake', { eventId, profileId: profile.id });
  const text = '在手机读取设备信息，并用一句话报告这部设备的型号和系统版本，不修改任何设置。';
  const result = await api('/api/voice/submit', { eventId, wakeId: wake.wakeId, text }); assert.equal(result.status, 'started', result.error); assert.equal(result.targetId, phone.id); runId = result.runId;
  let run;
  await until(async () => { run = (await api('/api/agent/runs')).find(r => r.id === runId); return run && run.status !== 'running'; }, 125000);
  assert.equal(run.status, 'completed', 'Android Agent ended ' + run.status + ': ' + String(run.result).replaceAll(key, '[REDACTED]').slice(0, 250));
  assert.ok(run.events.some(e => e.tool === 'get_device_info' && e.kind === 'tool'), 'Real Android Agent did not execute the requested local device tool');
  const again = await api('/api/voice/submit', { eventId, wakeId: wake.wakeId, text }); assert.equal(again.runId, runId); assert.equal(again.status, 'duplicate');
  const evidence = { suite: 'voice-android-agent-live', passed: true, host: 'real pinned TLS/WSS', device: 'Android 12 x86_64 emulator', agent: 'real existing Android AgentEngine', model: 'glm-5.3-flash', providerBase: 'https://open.bigmodel.cn/api/paas/v4', mode: run.mode, status: run.status, localDeviceInfoTool: true, replayCreatesNewRun: false, cloudAsr: false, credentialsRecorded: false };
  await mkdir(generatedEvidencePath(root, 'tests/evidence/voice-v1.0.0'), { recursive: true }); await writeFile(generatedEvidencePath(root, 'tests/evidence/voice-v1.0.0/android-agent-live.json'), JSON.stringify(evidence, null, 2));
  console.log('PASS real Room voice -> Android AgentEngine -> local device info -> completed; retry reused run');
} finally {
  if (runId) try { await api('/api/agent/runs/' + runId, undefined, 'DELETE'); } catch { }
  if (child && child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; }
  await rm(handshake, { force: true });
  if (!data.startsWith(resolve(tmpdir()) + '\\NexusRoom-voice-android-')) throw new Error('Unsafe test cleanup target');
  await rm(data, { recursive: true, force: true });
}
