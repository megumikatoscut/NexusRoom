import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Run only against an explicitly selected disposable Host and a real APK.
// No credentials or original file contents are written to the evidence.
const release = JSON.parse(await readFile(new URL('../release.json', import.meta.url), 'utf8'));
const versionTag = 'v' + release.version.replaceAll('.', '');
const launchFile = process.env.NEXUS_LIVE_LAUNCH_FILE;
const roomId = process.env.NEXUS_LIVE_ROOM_ID;
const profileId = process.env.NEXUS_LIVE_PROFILE_ID;
const deviceId = process.env.NEXUS_LIVE_DEVICE_ID;
const source = resolve(process.env.NEXUS_LIVE_FILE || 'test.txt');
const requestSource = resolve(process.env.NEXUS_LIVE_REQUEST_FILE || source);
const workspacePath = resolve(process.env.NEXUS_LIVE_WORKSPACE || resolve(source, '..'));
const serial = process.env.NEXUS_QA_SERIAL;
const adbExe = process.env.NEXUS_QA_ADB;
const evidence = resolve(process.env.NEXUS_LIVE_EVIDENCE || `.local/${versionTag}/pc-room-files-live.json`);
assert.ok(launchFile && roomId && profileId && deviceId && serial && adbExe,
  'Explicit disposable Host, model, real Android device and ADB are required');
const decrypt = 'Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($env:NEXUS_LIVE_READ_FILE),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))';
const launch = new URL(JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', decrypt], {
  encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  env: { ...process.env, NEXUS_LIVE_READ_FILE: resolve(launchFile) }
}).trim()));
assert.equal(launch.hostname, '127.0.0.1');
const token = decodeURIComponent(launch.hash.slice('#bootstrap='.length));
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(launch.origin + path, { method,
    headers: { Authorization: 'Bearer ' + token, 'X-Nexus-Request': '1',
      'X-Nexus-Room': roomId, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error('Live QA HTTP ' + response.status + ' at ' + path);
  return response.json();
}
const pause = ms => new Promise(done => setTimeout(done, ms));
async function until(check, label, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await pause(300); }
  throw new Error('Live QA timed out: ' + label);
}
const version = (await api('/health')).version;
assert.equal(version, release.version);
assert.ok((await api('/api/state')).devices.some(d => d.id === deviceId && d.online && d.permissions.files && d.permissions.agent));
const task = `把 ${source} 文件发送到手机端`;
const start = (mode, file = source) => api('/api/agent/runs', { targetId: 'pc:' + roomId, task: `把 ${file} 文件发送到手机端`,
  mode, profileId, workspacePath });
const getRun = async id => (await api('/api/agent/runs')).find(run => run.id === id);
const done = id => until(async () => { const run = await getRun(id); return run?.status !== 'running' ? run : false; }, 'run ' + id);
function roomToolsOnly(run) {
  const tools = run.events.filter(e => e.kind === 'tool').map(e => e.tool);
  assert.ok(tools.length > 0 && tools.every(tool => ['list_room_devices', 'send_file_to_phone'].includes(tool)),
    'A send-only request used unrelated tools: ' + tools.join(', '));
  return tools;
}
async function receiptOf(run, expectedPath) {
  const bytes = await readFile(expectedPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(run.status, 'completed', run.result);
  const tools = roomToolsOnly(run);
  const call = run.events.find(e => e.kind === 'tool' && e.tool === 'send_file_to_phone');
  assert.ok(call, 'Real model did not select send_file_to_phone');
  const event = run.events.find(e => e.kind === 'result' && e.tool === call.tool && e.requestId === call.requestId);
  assert.ok(event, 'Real SDK result lost its tool name or call ID');
  const receipt = JSON.parse(event.text);
  assert.equal(receipt.verified, true); assert.equal(receipt.deviceId, deviceId);
  assert.equal(receipt.sha256, sha256); assert.equal(receipt.size, bytes.length);
  const transfer = (await api('/api/state')).transfers.find(t => t.id === receipt.fileId);
  assert.equal(transfer.status, 'completed'); assert.equal(transfer.sha256, sha256);
  assert.ok(typeof receipt.savedTo === 'string' && /^Download\/NexusRoom\//.test(receipt.savedTo));
  assert.ok(!receipt.savedTo.includes('..') && !/[\r\n\0]/.test(receipt.savedTo));
  const remote = '/sdcard/' + receipt.savedTo;
  const quoted = "'" + remote.replaceAll("'", "'\\''") + "'";
  const actual = execFileSync(adbExe, ['-s', serial, 'shell', 'sha256sum ' + quoted], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000
  }).trim().split(/\s+/)[0];
  assert.equal(actual, sha256, 'Real APK saved different bytes');
  return { runId: run.id, status: run.status, fileId: receipt.fileId, savedTo: receipt.savedTo,
    size: receipt.size, sha256, verified: true, tools };
}
const automatic = await receiptOf(await done((await start('automatic')).id), source);
console.log('PASS exact Chinese prompt: real DeepSeek selects room file tool; APK saves matching SHA-256');
async function pending(id, expectedPath = source) {
  const value = await until(async () => {
    const run = await getRun(id);
    assert.equal(run.status, 'running', 'Task ended before file approval');
    const approval = (await api('/api/state')).approvals.find(a => a.runId === id);
    return approval && run.events.some(e => e.kind === 'permission_required' && e.requestId === approval.requestId) ? approval : false;
  }, 'file approval');
  assert.equal(value.tool, 'send_file_to_phone');
  assert.equal(value.arguments.path, expectedPath); assert.equal(value.arguments.deviceId, deviceId);
  return value;
}
const approvedStart = await start('request', requestSource);
const allow = await pending(approvedStart.id, requestSource);
const countBefore = (await api('/api/state')).transfers.length;
await pause(500);
assert.equal((await api('/api/state')).transfers.length, countBefore, 'File imported before approval');
await api('/api/approvals/' + allow.id, { allow: true });
const approved = await receiptOf(await done(approvedStart.id), requestSource);
console.log('PASS real request-mode approval, correlated result and APK receipt');
const beforeDenied = (await api('/api/state')).transfers.length;
const rejectedStart = await start('request');
const deny = await pending(rejectedStart.id);
await api('/api/approvals/' + deny.id, { allow: false });
const rejected = await done(rejectedStart.id);
assert.equal(rejected.status, 'failed');
const rejectedTools = roomToolsOnly(rejected);
assert.equal((await api('/api/state')).transfers.length, beforeDenied);
console.log('PASS real request-mode rejection sends no file');
const cancelledStart = await start('request');
await pending(cancelledStart.id);
await api('/api/agent/runs/' + cancelledStart.id, undefined, 'DELETE');
const cancelled = await done(cancelledStart.id);
assert.equal(cancelled.status, 'cancelled');
const cancelledTools = roomToolsOnly(cancelled);
assert.equal((await api('/api/state')).transfers.length, beforeDenied);
assert.equal((await api('/api/state')).approvals.some(a => a.runId === cancelledStart.id), false);
console.log('PASS real Stop cancels pending approval and sends no file');
const result = { version, status: 'passed', prompt: task, model: 'deepseek-flash', roomId,
  deviceId, automatic, approved, rejected: { runId: rejected.id, status: rejected.status, noTransfer: true, tools: rejectedTools },
  cancelled: { runId: cancelled.id, status: cancelled.status, noTransfer: true, noPendingApproval: true, tools: cancelledTools },
  timestamp: new Date().toISOString() };
await mkdir(resolve(evidence, '..'), { recursive: true });
await writeFile(evidence, JSON.stringify(result, null, 2));
console.log('Live PC room-file evidence: ' + evidence);
