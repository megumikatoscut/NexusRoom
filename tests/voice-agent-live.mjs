import { projectPath, generatedEvidencePath } from '../scripts/submission-paths.mjs';
// Explicitly opt in with NEXUS_TEST_MODEL_KEY and NEXUS_HARNESS_DIR.
// Sends recognised local WAV text through Room voice routing into the real
// existing Windows Harness. All writes stay in a dedicated temporary workspace.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const key = process.env.NEXUS_TEST_MODEL_KEY;
assert.ok(key, 'An explicitly authorized test key is required');
assert.ok(process.env.NEXUS_HARNESS_DIR, 'Point NEXUS_HARNESS_DIR at the fixed existing Harness runtime');
const nativeResult = JSON.parse(await readFile(projectPath(root, 'tests/evidence/voice-v1.0.0/windows-native.json'), 'utf8'));
const text = String(nativeResult.english).replace(/^(?:hi|high|hey)\s*(?:nexus|next\s*is)\s*/i, '').trim();
assert.match(text, /COMPUTER/i); assert.match(text, /TEXT FILE/i);
await mkdir(projectPath(root, '.local'), { recursive: true });
const data = await mkdtemp(projectPath(root, '.local/voice-agent-live-'));
const workspace = resolve(data, 'workspace'); await mkdir(workspace);
const ui = 18790, device = 18791;
let child, admin, room, runId;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(check, timeout = 15000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return; await wait(200); } throw new Error('Live voice task timed out'); }
function launch() { const path = resolve(data, 'launch.dat').replaceAll("'", "''"); return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes('${path}'),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))`], { encoding: 'utf8', windowsHide: true }).trim()); }
async function api(path, body, method = body === undefined ? 'GET' : 'POST') { const r = await fetch(`http://127.0.0.1:${ui}${path}`, { method, headers: { Authorization: `Bearer ${admin}`, 'X-Nexus-Request': '1', 'X-Nexus-Room': room || '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); const value = await r.json(); assert.equal(r.status, 200, value.title || 'Host API error'); return value; }
try {
  const environment = { ...process.env, NEXUS_DATA_DIR: data, NEXUS_UI_PORT: '' + ui, NEXUS_DEVICE_PORT: '' + device, NEXUS_DISCOVERY_PORT: '18792', NEXUS_DISABLE_MDNS: '1' };
  // Parent alone uses the provisioning key. The Host receives it through its
  // authenticated API and stores its normal DPAPI protected Room profile.
  delete environment.NEXUS_TEST_MODEL_KEY;
  child = spawn('dotnet', [process.env.NEXUS_TEST_HOST_DLL || projectPath(root, 'src/NexusRoom.Host/bin/Debug/net10.0-windows/NexusRoom.Host.dll'), '--headless'], { windowsHide: true, env: environment, stdio: 'ignore' });
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${ui}/health`)).ok; } catch { return false; } });
  admin = new URL(launch()).hash.split('=')[1]; room = (await api('/api/invitation')).roomId;
  const profile = await api('/api/settings/profiles', { name: 'Authorized ephemeral GLM validation', apiType: 'chat_completions', apiUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash', apiKey: key, maxCalls: 6, maxSteps: 6, timeoutSeconds: 120 });
  const eventId = randomUUID();
  const wake = await api('/api/voice/wake', { eventId, profileId: profile.id, workspacePath: workspace });
  const start = await api('/api/voice/submit', { eventId, wakeId: wake.wakeId, text });
  assert.equal(start.status, 'started', start.error); assert.equal(start.targetId, 'pc:' + room); runId = start.runId;
  let run;
  await until(async () => { run = (await api('/api/agent/runs')).find(r => r.id === runId); return run && run.status !== 'running'; }, 125000);
  assert.equal(run.status, 'completed', 'Real Harness task ended ' + run.status + ': ' + String(run.result).replaceAll(key, '[REDACTED]').slice(0, 500));
  const files = await readdir(workspace); assert.ok(files.some(f => /\.txt$/i.test(f)), 'Local recognised speech task did not create its requested text file');
  const repeated = await api('/api/voice/submit', { eventId, wakeId: wake.wakeId, text }); assert.equal(repeated.status, 'duplicate'); assert.equal(repeated.runId, runId);
  const evidence = { suite: 'voice-agent-live', passed: true, recognizer: 'real local sherpa-onnx WAV', agent: 'real existing Windows Harness', model: 'glm-5.3-flash', providerBase: 'https://open.bigmodel.cn/api/paas/v4', mode: run.mode, status: run.status, toolEvents: run.events.filter(e => e.kind === 'tool').length, outputTextFiles: files.filter(f => /\.txt$/i.test(f)).length, replayCreatesNewRun: false, cloudAsr: false, credentialsRecorded: false };
  await mkdir(generatedEvidencePath(root, 'tests/evidence/voice-v1.0.0'), { recursive: true }); await writeFile(generatedEvidencePath(root, 'tests/evidence/voice-v1.0.0/agent-live.json'), JSON.stringify(evidence, null, 2));
  console.log('PASS real offline ASR text -> Room voice -> Windows Harness -> verified local text file; retry reused run');
} finally {
  if (runId) try { await api('/api/agent/runs/' + runId, undefined, 'DELETE'); } catch { }
  if (child && child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; }
  // Explicitly created test directory is removed with one filesystem API;
  // no credential-bearing profile or Harness session is left in the repo.
  if (!data.startsWith(projectPath(root, '.local') + '\\')) throw new Error('Cleanup escaped isolated workspace');
  await rm(data, { recursive: true, force: true });
}
