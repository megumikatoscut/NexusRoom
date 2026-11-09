import { projectPath, generatedEvidencePath } from '../scripts/submission-paths.mjs';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import https from 'node:https';
import WebSocket from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(projectPath(root, '.local'), { recursive: true });
const data = await mkdtemp(projectPath(root, '.local/voice-room-'));
const ports = { ui: 18690, device: 18691, discovery: 18692 };
let child, diagnostic = '', admin, room, fingerprint, device, socket, starts = 0, checks = 0;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(check, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return; await wait(100); } throw new Error('Voice fixture timeout'); }
function protectedJson(filename) {
  const path = resolve(data, filename).replaceAll("'", "''");
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes('${path}'),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))`], { encoding: 'utf8', windowsHide: true }).trim());
}
async function start() {
  child = spawn('dotnet', [projectPath(root, 'src/NexusRoom.Host/bin/Debug/net10.0-windows/NexusRoom.Host.dll'), '--headless'], { cwd: root, windowsHide: true, env: { ...process.env, NEXUS_DATA_DIR: data, NEXUS_UI_PORT: '' + ports.ui, NEXUS_DEVICE_PORT: '' + ports.device, NEXUS_DISCOVERY_PORT: '' + ports.discovery, NEXUS_DISABLE_MDNS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => { diagnostic += d; }); child.stderr.on('data', d => { diagnostic += d; });
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${ports.ui}/health`)).ok; } catch { return false; } });
  admin = new URL(protectedJson('launch.dat')).hash.split('=')[1];
}
async function host(path, body, method = body === undefined ? 'GET' : 'POST', token = admin, selectedRoom = room) {
  const res = await fetch(`http://127.0.0.1:${ports.ui}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'X-Nexus-Request': '1', 'X-Nexus-Room': selectedRoom || '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, value: await res.json() };
}
async function mobile(path, body, method = body === undefined ? 'GET' : 'POST', token = device?.token || '') {
  return new Promise((done, reject) => {
    const req = https.request(`https://127.0.0.1:${ports.device}${path}`, { method, rejectUnauthorized: false, agent: false, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, res => {
      try { assert.equal(createHash('sha256').update(res.socket.getPeerCertificate().raw).digest('hex'), fingerprint); } catch (e) { reject(e); return; }
      const chunks = []; res.on('data', d => chunks.push(d)); res.on('end', () => done({ status: res.statusCode, value: JSON.parse(Buffer.concat(chunks)) }));
    }); req.on('error', reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end();
  });
}
async function connect() {
  socket = new WebSocket(`wss://127.0.0.1:${ports.device}/device/ws`, { rejectUnauthorized: false, headers: { Authorization: `Bearer ${device.token}` } });
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString()); if (message.type !== 'command') return;
    socket.send(JSON.stringify({ type: 'result', id: message.id, result: message.tool === 'agent_start' ? { accepted: true } : { ok: true } }));
    if (message.tool === 'agent_start') {
      starts++; const id = message.arguments.taskId;
      assert.equal(message.arguments.mode, 'automatic');
      setTimeout(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'agent_event', taskId: id, status: 'completed', result: 'Fixture local Agent completed' })); }, 300);
    }
  });
  await once(socket, 'open'); socket.send(JSON.stringify({ type: 'hello', permissions: { agent: true } }));
  await until(async () => (await host('/api/state')).value.devices.some(d => d.id === device.deviceId && d.online && d.permissions.agent));
}
async function check(name, action) { await action(); checks++; console.log('PASS ' + name); }
async function idle() { await until(async () => (await host('/api/agent/runs')).value.every(r => r.status !== 'running')); }
async function stop() { socket?.close(); await wait(100); if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } }
try {
  await start(); const invite = (await host('/api/invitation')).value; room = invite.roomId; fingerprint = invite.fingerprint;
  await check('voice disabled by default and model content present', async () => { const s = await host('/api/voice/status'); assert.equal(s.value.enabled, false); assert.equal(s.value.ready, true); });
  await check('voice endpoints require console/device authentication', async () => { assert.equal((await host('/api/voice/tasks', undefined, 'GET', '')).status, 401); assert.equal((await mobile('/device/voice/wake', { eventId: randomUUID() }, 'POST', '')).status, 401); });
  device = (await mobile('/device/join', { roomId: room, password: invite.password, name: 'Voice fixture phone', version: '1.0.0', physicalId: randomUUID(), model: 'Fixture' })).value;
  await connect();
  const plan = (await host('/api/settings/profiles', { name: 'Voice fixture', apiType: 'chat_completions', apiUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture-only-key', maxCalls: 2, maxSteps: 2, timeoutSeconds: 30 })).value;
  assert.ok(plan.id);
  const pcEvent = randomUUID(), phoneEvent = randomUUID();
  const pcWake = (await host('/api/voice/wake', { eventId: pcEvent, profileId: plan.id })).value;
  const phoneWake = (await mobile('/device/voice/wake', { eventId: phoneEvent, profileId: plan.id })).value;
  await check('dual-end wakes arbitrated into one Room event', async () => assert.equal(pcWake.wakeId, phoneWake.wakeId));
  const [one, two] = await Promise.all([host('/api/voice/submit', { wakeId: pcWake.wakeId, eventId: pcEvent, text: 'Hi Nexus, 在手机读取设备信息。' }), mobile('/device/voice/submit', { wakeId: phoneWake.wakeId, eventId: phoneEvent, text: '在手机读取设备信息' })]);
  await check('dual-end submit creates one existing Agent run', async () => { assert.equal(one.status, 200); assert.equal(two.status, 200); assert.equal(one.value.taskId, two.value.taskId); assert.equal(one.value.runId, two.value.runId); assert.equal(one.value.targetId, device.deviceId); assert.deepEqual([one.value.status, two.value.status].sort(), ['duplicate', 'started']); });
  await idle(); assert.equal(starts, 1);
  await check('concurrent retries never replay execution', async () => {
    const retries = await Promise.all(Array.from({ length: 12 }, () => mobile('/device/voice/submit', { wakeId: phoneWake.wakeId, eventId: phoneEvent, text: '在手机读取设备信息' })));
    assert.ok(retries.every(r => r.value.runId === one.value.runId && r.value.status === 'duplicate')); assert.equal(starts, 1);
  });
  await check('same words in a separate wake remain a new user instruction', async () => { const eventId = randomUUID(); const w = (await host('/api/voice/wake', { eventId, profileId: plan.id })).value; assert.notEqual(w.wakeId, pcWake.wakeId); const r = await host('/api/voice/submit', { eventId, wakeId: w.wakeId, text: '在手机读取设备信息' }); assert.equal(r.value.status, 'started'); assert.notEqual(r.value.taskId, one.value.taskId); await idle(); assert.equal(starts, 2); });
  await check('wrong-source token cannot submit another listener event', async () => assert.equal((await mobile('/device/voice/submit', { wakeId: pcWake.wakeId, eventId: pcEvent, text: '在手机打开设置' })).status, 403));
  const otherRoom = (await host('/api/rooms', { name: 'Voice other Room' })).value;
  await check('cross-room wake replay denied', async () => assert.equal((await host('/api/voice/submit', { wakeId: pcWake.wakeId, eventId: pcEvent, text: '在手机打开设置' }, 'POST', admin, otherRoom.id)).status, 403));
  await check('cancelled wake cannot execute', async () => { const eventId = randomUUID(); const w = (await mobile('/device/voice/wake', { eventId, profileId: plan.id })).value; assert.equal((await mobile('/device/voice/cancel', { eventId, wakeId: w.wakeId })).status, 200); assert.equal((await mobile('/device/voice/submit', { eventId, wakeId: w.wakeId, text: '在手机打开设置' })).status, 409); });
  await check('disabled manual microphone cannot record or send tasks', async () => { assert.equal((await host('/api/voice/manual/start', {})).status, 409); assert.equal(starts, 2); });
  await check('voice permission revocation is enforced', async () => { socket.send(JSON.stringify({ type: 'hello', permissions: { agent: false } })); await until(async () => !(await host('/api/state')).value.devices.find(d => d.id === device.deviceId).permissions.agent); assert.equal((await mobile('/device/voice/wake', { eventId: randomUUID() })).status, 403); });
  await stop(); await start(); await connect();
  await check('durable retry after Host restart cannot recapture or replay Agent', async () => { const w = (await mobile('/device/voice/wake', { eventId: phoneEvent, profileId: plan.id })).value; assert.equal(w.wakeId, phoneWake.wakeId); assert.equal(w.capture, false); const r = await mobile('/device/voice/submit', { eventId: phoneEvent, wakeId: phoneWake.wakeId, text: '在手机读取设备信息' }); assert.equal(r.value.status, 'duplicate'); assert.equal(r.value.runId, one.value.runId); assert.equal(starts, 2); assert.equal((await host('/api/agent/runs')).value.length, 0); });
  await mkdir(generatedEvidencePath(root, 'tests/evidence/voice-v1.0.0'), { recursive: true });
  await writeFile(generatedEvidencePath(root, 'tests/evidence/voice-v1.0.0/room.json'), JSON.stringify({ suite: 'voice-room', checks, passed: true, realHost: true, deviceRpcFixture: true, cloudAsr: false, credentials: false }, null, 2));
  console.log(`Room voice: ${checks} checks passed.`);
} catch (error) { console.error(error); console.error(diagnostic.slice(-2500)); process.exitCode = 1; }
finally { await stop(); }
