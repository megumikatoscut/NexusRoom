import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Run after a real PC Agent delivery on a disposable, explicitly selected phone.
// This invokes the Android-local model and send_file_to_pc, then verifies the
// returned room-library bytes. Credentials never enter evidence or output.
if (process.argv.includes('--help')) {
  console.log([
    'Usage: node tests/android-file-transfer-live.mjs',
    'Required: NEXUS_LIVE_LAUNCH_FILE, NEXUS_ANDROID_ROUNDTRIP_FILE (original PC source)',
    'Select phone: NEXUS_QA_SERIAL, NEXUS_ANDROID_ROOM_ID, NEXUS_ANDROID_DEVICE_ID',
    '  or NEXUS_ANDROID_PREPARE_RESULT (sanitized QA environment JSON)',
    'Optional: NEXUS_QA_ADB, NEXUS_ANDROID_UPLOAD_PROFILE_ID, NEXUS_ANDROID_UPLOAD_EVIDENCE',
    '  NEXUS_ANDROID_ROUNDTRIP_PHONE_PATH (exact savedTo path from the latest PC receipt)',
    'The room needs an authorized deepseek-flash profile and actual Android Agent/files grants.',
    'The received source file must exist in Android Download/NexusRoom, with All Files Access granted.'
  ].join('\n'));
  process.exit(0);
}

const release = JSON.parse(await readFile(new URL('../release.json', import.meta.url), 'utf8'));
const versionTag = 'v' + release.version.replaceAll('.', '');
const launchFile = process.env.NEXUS_LIVE_LAUNCH_FILE;
const prepared = process.env.NEXUS_ANDROID_PREPARE_RESULT
  ? JSON.parse(await readFile(resolve(process.env.NEXUS_ANDROID_PREPARE_RESULT), 'utf8'))
  : { serial: process.env.NEXUS_QA_SERIAL, adb: process.env.NEXUS_QA_ADB,
      roomId: process.env.NEXUS_ANDROID_ROOM_ID, deviceId: process.env.NEXUS_ANDROID_DEVICE_ID };
assert.ok(prepared.serial && prepared.roomId && prepared.deviceId, 'Select an isolated QA serial, room and member, or provide NEXUS_ANDROID_PREPARE_RESULT');
const expectedPath = process.env.NEXUS_ANDROID_ROUNDTRIP_FILE;
assert.ok(launchFile && expectedPath, 'A QA launch file and original PC source file are required');
const evidence = resolve(process.env.NEXUS_ANDROID_UPLOAD_EVIDENCE || `.local/${versionTag}/android-upload`);
const adbExe = prepared.adb || 'adb', serial = prepared.serial;
const phonePath = process.env.NEXUS_ANDROID_ROUNDTRIP_PHONE_PATH || '/sdcard/Download/NexusRoom/' + basename(expectedPath);
assert.ok(phonePath.startsWith('/sdcard/Download/NexusRoom/') && !phonePath.slice('/sdcard/Download/NexusRoom/'.length).includes('/')
  && !/[\r\n\0]/.test(phonePath) && !phonePath.split('/').includes('..'), 'Use the exact room receipt path in Download/NexusRoom');
const name = basename(phonePath);
const source = await readFile(expectedPath), sha256 = createHash('sha256').update(source).digest('hex');
const script = 'Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($env:NEXUS_ANDROID_READ_FILE),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))';
const launch = new URL(JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
  encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, NEXUS_ANDROID_READ_FILE: resolve(launchFile) }
}).trim()));
const token = decodeURIComponent(launch.hash.slice('#bootstrap='.length));
const headers = { Authorization: 'Bearer ' + token, 'X-Nexus-Request': '1', 'X-Nexus-Room': prepared.roomId, 'Content-Type': 'application/json' };
async function api(path, body) {
  const response = await fetch(launch.origin + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('QA room API HTTP ' + response.status + ' at ' + path);
  return response.json();
}
const quotedPhonePath = "'" + phonePath.replaceAll("'", "'\\''") + "'";
const phoneHash = execFileSync(adbExe, ['-s', serial, 'shell', 'sha256sum', quotedPhonePath], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/)[0];
assert.equal(phoneHash, sha256, 'PC Agent transfer did not save the original bytes on Android');
const before = await api('/api/state'), knownIds = new Set(before.transfers.map(item => item.id));
const settings = await api('/api/settings');
const profile = settings.profiles.find(item => item.id === process.env.NEXUS_ANDROID_UPLOAD_PROFILE_ID)
  || settings.profiles.find(item => item.model === 'deepseek-flash' && item.hasKey);
assert.ok(profile?.hasKey, 'An authorized DeepSeek QA profile is required');
const started = await api('/api/agent/runs', { deviceId: prepared.deviceId, mode: 'automatic', profileId: profile.id,
  task: '请在这台手机通过 find_phone_files 或 list_phone_files 找到 Download/NexusRoom/' + name + '，然后使用专用 send_file_to_pc 工具发送到当前房间的电脑。只发送这一份文件。不读取文件内容，不打开其他应用，不使用分享面板。以工具实际收到的电脑收件结果为依据回复。' });
let run;
const deadline = Date.now() + 260000;
while (Date.now() < deadline) {
  run = (await api('/api/agent/runs')).find(item => item.id === started.id);
  if (run && ['completed', 'failed', 'cancelled'].includes(run.status)) break;
  await new Promise(done => setTimeout(done, 900));
}
if (run?.status === 'running') {
  await fetch(launch.origin + '/api/agent/runs/' + started.id, { method: 'DELETE', headers });
}
await mkdir(evidence, { recursive: true });
const state = await api('/api/state');
const received = state.transfers.find(item => !knownIds.has(item.id) && item.direction === 'toWindows' && item.deviceId === prepared.deviceId && item.name === name && item.status === 'completed');
const tools = (run?.events || []).filter(event => event.kind === 'tool').map(event => event.tool);
let status = 'failed', error;
try {
  assert.equal(run?.status, 'completed', 'Real Android model task did not complete');
  assert.ok(tools.includes('send_file_to_pc'), 'The phone did not call its dedicated room transfer tool');
  assert.ok(received, 'The room file library has no completed Android upload');
  assert.equal(received.size, source.length); assert.equal(received.sha256, sha256);
  const response = await fetch(launch.origin + '/api/files/' + received.id, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), source, 'PC file library bytes differ from the original');
  status = 'passed';
} catch (failure) { error = failure.message; }
const result = { version: release.version, status, error, model: profile.model, roomId: prepared.roomId, deviceId: prepared.deviceId,
  runId: started.id, runStatus: run?.status, tools, file: { name, size: source.length, sha256, phonePath, phoneSha256: phoneHash, returnTransferId: received?.id },
  time: new Date().toISOString() };
await writeFile(resolve(evidence, 'upload-result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (status !== 'passed') process.exitCode = 1;
