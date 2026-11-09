import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import WebSocket from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = JSON.parse(await readFile(resolve(root, 'release.json'), 'utf8'));
const data = resolve(root, '.local', 'pc-remote-contract-' + Date.now());
const evidence = resolve(data, 'evidence');
const runtime = resolve(data, 'runtime');
await mkdir(evidence, { recursive: true }); await mkdir(resolve(runtime, 'apps/cli/lib'), { recursive: true });
await copyFile(resolve(root, 'tests/fixtures/harness-runtime.mjs'), resolve(runtime, 'apps/cli/lib/bin.js'));
const uiPort = Number(process.env.NEXUS_REMOTE_UI_PORT || 18790), devicePort = uiPort + 1;
const child = spawn(process.env.NEXUS_TEST_HOST || 'dotnet', process.env.NEXUS_TEST_HOST ? ['--headless'] : [process.env.NEXUS_TEST_HOST_DLL || resolve(root, 'src/NexusRoom.Host/bin/Debug/net10.0-windows/NexusRoom.Host.dll'), '--headless'], {
  windowsHide: true, cwd: root, env: { ...process.env, NEXUS_DATA_DIR: data, NEXUS_UI_PORT: String(uiPort), NEXUS_DEVICE_PORT: String(devicePort), NEXUS_DISCOVERY_PORT: String(uiPort + 2), NEXUS_DISABLE_MDNS: '1', NEXUS_HARNESS_DIR: runtime }, stdio: ['ignore', 'pipe', 'pipe']
});
let diagnostics = ''; child.stdout.on('data', b => diagnostics += b); child.stderr.on('data', b => diagnostics += b);
const fixtureLauncher = resolve(root, 'tests/fixtures/StartPcRemoteFixture.ps1');
let fixture;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(action, ms = 12000) { const end = Date.now() + ms; while (Date.now() < end) { const value = await action(); if (value) return value; await pause(80); } throw new Error('Condition timed out'); }
let token = '', roomId = '', seq = 0, checks = 0;
const sockets = [];
async function local(path, body, method = body === undefined ? 'GET' : 'POST', room = roomId) {
  const res = await fetch('http://127.0.0.1:' + uiPort + path, { method, headers: { Authorization: 'Bearer ' + token, 'X-Nexus-Request': '1', 'X-Nexus-Room': room, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, value: await res.json() };
}
function mobile(path, member, body, method = body === undefined ? 'GET' : 'POST') {
  return new Promise((resolve, reject) => {
    const req = https.request('https://127.0.0.1:' + devicePort + path, { method, rejectUnauthorized: false, agent: false, headers: { Authorization: member ? 'Bearer ' + member.token : '', 'Content-Type': 'application/json' } }, res => {
      const chunks = []; res.on('data', b => chunks.push(b)); res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(Buffer.concat(chunks)) }));
    }); req.on('error', reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end();
  });
}
async function api(path, body, method, room) { const res = await local(path, body, method, room); assert.equal(res.status, 200, JSON.stringify(res.value)); return res.value; }
async function device(path, member, body, method) { const res = await mobile(path, member, body, method); assert.equal(res.status, 200, JSON.stringify(res.value)); return res.value; }
async function check(name, action) { await action(); checks++; console.log('PASS ' + name); }
async function state() {
  try {
    const value = JSON.parse(await readFile(resolve(evidence, 'fixture-state.json'), 'utf8'));
    return fixture && value?.pid === fixture.pid && value?.hwnd > 0 && value?.snapshotAt > 0 && value?.textbox?.width > 0 && Date.now() - value.snapshotAt < 1000 ? value : null;
  } catch { return null; }
}
function focusFixture(pid, hwnd) {
  const args = ['-NoProfile', '-File', resolve(root, 'tests/fixtures/FocusFixture.ps1'), '-StateFile', resolve(evidence, 'fixture-state.json')];
  let result;
  try { result = JSON.parse(execFileSync('powershell.exe', [...args, '-Activate', '-Click'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch (error) { console.error('Activation diagnostics', error.stdout?.toString()); throw error; }
  assert.equal(result.fixturePid, pid);
  if (result.afterPid !== pid) {
    assert.equal(result.hitPid, pid, 'Refusing activation click outside fixture');
    execFileSync('powershell.exe', [...args, '-Click'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  }
}
function coordinate(bounds, snapshot) { const full = snapshot.virtualScreen; return { x: (bounds.x + bounds.width / 2 - full.x) / (full.width - 1), y: (bounds.y + bounds.height / 2 - full.y) / (full.height - 1) }; }
function joinLink(member) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket('wss://127.0.0.1:' + devicePort + '/device/ws', { rejectUnauthorized: false, headers: { Authorization: 'Bearer ' + member.token } }); sockets.push(socket);
    socket.on('error', reject); socket.on('open', () => { socket.send(JSON.stringify({ type: 'hello', permissions: {}, activity: 'online' })); resolve(socket); });
    socket.on('message', bytes => { const value = JSON.parse(bytes); if (value.type === 'command') socket.send(JSON.stringify({ type: 'result', id: value.id, result: { ok: true } })); });
  });
}
async function rejectedSocket(member, sessionId, status) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://127.0.0.1:' + devicePort + '/device/pc/ws?sessionId=' + sessionId, { rejectUnauthorized: false, headers: { Authorization: 'Bearer ' + member.token } });
    ws.on('open', () => { ws.terminate(); reject(new Error('Unauthorized remote socket opened')); });
    ws.on('unexpected-response', (_, response) => { assert.equal(response.statusCode, status); response.resume(); ws.terminate(); resolve(); });
    ws.on('error', () => {});
  });
}
async function openRemote(member, sessionId, legacy = false) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://127.0.0.1:' + devicePort + '/device/pc/ws?sessionId=' + sessionId, { rejectUnauthorized: false, headers: { Authorization: 'Bearer ' + member.token } }); sockets.push(ws);
    const result = { ws, packets: [], text: [], pending: new Map(), ping: null, nextSequence: 0 };
    ws.on('error', reject);
    ws.on('close', () => { clearInterval(result.ping); for (const pending of result.pending.values()) pending.reject(new Error('Socket closed')); result.pending.clear(); });
    ws.on('message', (bytes, binary) => {
      if (binary) { result.packets.push(Buffer.from(bytes)); if (result.packets.length > 600) result.packets.shift(); return; }
      const value = JSON.parse(bytes); result.text.push(value);
      if (value.type === 'welcome') { result.welcome = value; result.ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' })); }, 5000); resolve(result); }
      if (value.type === 'result') { result.pending.get(value.id)?.resolve(value); result.pending.delete(value.id); }
    });
    result.request = (tool, args, fields = {}) => new Promise((resolve, reject) => {
      const id = 'qa-' + (++seq);
      const frame = { type: 'input', id, tool, arguments: args, ...(legacy ? {} : { seq: ++result.nextSequence }), ...fields };
      result.pending.set(frame.id, { resolve, reject }); ws.send(JSON.stringify(frame));
    });
    result.input = async (tool, args) => {
      const observed = await until(async () => { const current = await state(); return current && Date.now() - current.snapshotAt < 500 ? current : null; }, 1500);
      assert.equal(observed?.foreground, true, 'Refusing QA input while its fixture is not the foreground window');
      assert.equal(observed.foregroundPid, observed.pid, 'Foreground process must be the disposable fixture');
      return result.request(tool, args);
    };
  });
}
const grants = { screen: true, control: true, audio: true, clipboard: true };
async function startRemote(member, room = roomId, options = {}, legacy = false) {
  const begun = await device('/device/pc/start', member, { maxSize: 1280, fps: 12, quality: 75, audio: true, ...options });
  await api('/api/pc/remote/decision', { sessionId: begun.sessionId, allow: true }, undefined, room);
  return { sessionId: begun.sessionId, ...(await openRemote(member, begun.sessionId, legacy)) };
}
function jpegSize(bytes) {
  let at = 2;
  while (at + 8 < bytes.length) {
    if (bytes[at] !== 255) { at++; continue; }
    const marker = bytes[at + 1]; const length = bytes.readUInt16BE(at + 2);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    at += length + 2;
  }
  throw new Error('JPEG has no dimensions');
}
try {
  fixture = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixtureLauncher,
    '-EvidenceDirectory', evidence, '-Tone'], { windowsHide: true, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.ok(Number.isInteger(fixture.pid) && fixture.pid > 0 && /^\d+$/.test(fixture.startTimeTicks), 'Fixture launcher returns an owned process identity');
  await until(async () => { try { return (await fetch('http://127.0.0.1:' + uiPort + '/health')).ok; } catch { return false; } });
  await until(state, 45000);
  const path = resolve(data, 'launch.dat').replaceAll("'", "''");
  const launch = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', "Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes('" + path + "'),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))"], { encoding: 'utf8', windowsHide: true }).trim());
  token = new URL(launch).hash.slice('#bootstrap='.length);
  roomId = (await api('/api/state')).room.id;
  const invite = await api('/api/invitation');
  const member = await device('/device/join', null, { roomId, password: invite.password, name: 'PC remote QA phone', version: release.version });
  const peer = await device('/device/join', null, { roomId, password: invite.password, name: 'PC remote QA peer', version: release.version });
  const link = await joinLink(member); await joinLink(peer);
  await until(async () => (await api('/api/state')).devices.filter(d => d.online).length === 2);
  await check('remote is off by default and does not depend on Android Agent permissions', async () => {
    assert.deepEqual((await device('/device/pc/status', member)).permissions, { screen: false, control: false, audio: false, clipboard: false });
    assert.equal((await mobile('/device/pc/start', member, {})).status, 403);
    await api('/api/pc/remote/permissions', grants);
    assert.equal((await mobile('/api/pc/remote/permissions', member, grants)).status, 403);
    assert.equal((await mobile('/device/pc/status', null)).status, 401);
  });
  const room2 = await api('/api/rooms', { name: 'PC remote boundary room' });
  const invite2 = await api('/api/invitation', undefined, undefined, room2.id);
  const stranger = await device('/device/join', null, { roomId: room2.id, password: invite2.password, name: 'Other room phone', version: release.version }); await joinLink(stranger);
  await api('/api/pc/remote/permissions', grants, undefined, room2.id);
  let pending;
  await check('each session requires local approval, hides session IDs and enforces room and actor boundaries', async () => {
    pending = await device('/device/pc/start', member, { maxSize: 1280, fps: 12, quality: 75, audio: true });
    assert.equal(pending.state, 'pending');
    await rejectedSocket(member, pending.sessionId, 409);
    assert.equal((await device('/device/pc/status', peer)).session.sessionId, '');
    assert.equal((await device('/device/pc/status', stranger)).activity, 'busy');
    assert.equal((await mobile('/device/pc/start', peer, {})).status, 409);
    assert.equal((await local('/api/pc/remote/decision', { sessionId: pending.sessionId, allow: true }, undefined, room2.id)).status, 403);
    assert.equal((await mobile('/device/pc/stop', peer, { sessionId: pending.sessionId })).status, 403);
    assert.equal((await mobile('/device/pc/stop', stranger, { sessionId: pending.sessionId })).status, 403);
    await api('/api/pc/remote/decision', { sessionId: pending.sessionId, allow: false });
    assert.equal((await device('/device/pc/status', member)).session, null);
    assert.equal((await api('/api/state')).host.activity, 'online');
  });
  let remote = await startRemote(member);
  await check('actual desktop JPEG and audible WASAPI loopback carry valid NRP3 dimensions and timestamps', async () => {
    await until(() => remote.packets.filter(p => p.readInt32BE(4) === 1).length > 2);
    const frame = remote.packets.find(p => p.readInt32BE(4) === 1);
    assert.equal(remote.welcome.inputProtocol, 'sequence-v1');
    assert.equal(frame.subarray(0, 4).toString(), 'NRP3'); assert.ok(frame.readBigInt64BE(8) >= 0n);
    assert.equal(frame.readUInt16BE(24), 0xffd8);
    const dimensions = jpegSize(frame.subarray(24));
    assert.equal(dimensions.width, frame.readInt32BE(16)); assert.equal(dimensions.height, frame.readInt32BE(20));
    assert.equal(dimensions.width, remote.welcome.width); assert.equal(dimensions.height, remote.welcome.height);
    assert.ok(Math.max(dimensions.width, dimensions.height) <= 1280);
    await writeFile(resolve(evidence, 'desktop.jpg'), frame.subarray(24));
    await until(() => remote.packets.filter(p => p.readInt32BE(4) === 2).length >= 10);
    const audio = remote.packets.filter(p => p.readInt32BE(4) === 2); let squared = 0, samples = 0;
    for (const packet of audio) { assert.ok(packet.readInt32BE(16) >= 8000); assert.equal(packet.readInt32BE(20), 1); assert.equal((packet.length - 24) % 2, 0); for (let at = 24; at < packet.length; at += 2) { const n = packet.readInt16LE(at); squared += n * n; samples++; } }
    const rms = Math.sqrt(squared / samples); assert.ok(rms > 100, 'Loopback must carry the actual fixture tone');
    await writeFile(resolve(evidence, 'media.json'), JSON.stringify({ ...dimensions, audioPackets: audio.length, audioRms: rms, sampleRate: audio[0].readInt32BE(16), channels: 1 }, null, 2));
    assert.equal((await api('/api/state')).host.activity, 'working');
    assert.equal((await device('/device/pc/status', member)).session.state, 'streaming');
  });
  await check('real Unicode text, key selection, pointer drag, right click and wheel reach Windows controls', async () => {
    let current = await until(state); focusFixture(current.pid, current.hwnd); await until(async () => { const observed = await state(); return observed?.foreground && observed.focused; }); current = await until(state);
    console.log('Fixture focus confirmed', { pid: current.pid, foreground: current.foreground, focused: current.focused });
    const text = 'NexusRoom 输入验证 🚀\n第二行'; assert.equal((await remote.input('text', { text })).error, undefined);
    await until(async () => (await state())?.text.replaceAll('\r\n', '\n') === text);
    await remote.input('key', { key: 'Ctrl+A' }); await remote.input('text', { text: '选中替换' });
    await until(async () => (await state())?.text === '选中替换');
    await remote.input('key', { key: 'End' }); await remote.input('key', { key: 'Backspace' });
    await until(async () => (await state())?.text === '选中替');
    current = await state(); await remote.input('click', coordinate(current.button, current));
    await until(async () => (await state())?.clicks > 0);
    current = await state(); const panel = coordinate(current.panel, current);
    await remote.input('pointer', { ...panel, action: 'down', button: 'left' });
    await remote.input('pointer', { x: panel.x + .015, y: panel.y + .015, action: 'move' });
    await remote.input('pointer', { ...panel, action: 'up', button: 'left' });
    await remote.input('click', { ...panel, button: 'right' }); await remote.input('scroll', { deltaX: 0, deltaY: -120 });
    await until(async () => { const observed = await state(); return observed.down > 0 && observed.up > 0 && observed.moves > 0 && observed.rightClicks > 0 && observed.wheel !== 0; });
    assert.ok((await remote.input('click', { x: -1, y: .5 })).error);
    assert.ok((await remote.input('key', { key: 'arbitrary-command' })).error);
  });
  await check('IME deletion repeats are bounded and invalid repeats do not change Windows text', async () => {
    let current = await until(state); focusFixture(current.pid, current.hwnd);
    await until(async () => { const observed = await state(); return observed?.foreground && observed.focused; });
    await remote.input('key', { key: 'Ctrl+A' }); await remote.input('text', { text: 'ABCDE' });
    await remote.input('key', { key: 'End' });
    assert.equal((await remote.input('key', { key: 'Backspace', count: 2 })).error, undefined);
    await until(async () => (await state())?.text === 'ABC');
    await remote.input('key', { key: 'Home' });
    assert.equal((await remote.input('key', { key: 'Delete', count: 2 })).error, undefined);
    await until(async () => (await state())?.text === 'C');
    for (const args of [{ key: 'Backspace', count: 0 }, { key: 'Delete', count: 65 }, { key: 'Backspace', count: 1.5 },
      { key: 'Backspace', count: '2' }, { key: 'Ctrl+A', count: 2 }, { key: 'Enter', count: 2 }]) {
      assert.ok((await remote.input('key', args)).error, JSON.stringify(args));
      assert.equal((await state()).text, 'C');
    }
    await remote.input('key', { key: 'Ctrl+A' }); await remote.input('text', { text: 'X'.repeat(64) });
    await remote.input('key', { key: 'End' }); await remote.input('key', { key: 'Backspace', count: 64 });
    await until(async () => (await state())?.text === '');
  });
  await check('sequenced input stays usable beyond 10000 commands without accepting stale operations', async () => {
    // Invalid coordinates exercise the real WS dispatcher and consume sequence
    // numbers without sending mouse input outside the disposable fixture.
    for (let offset = 0; offset < 10048; offset += 64) {
      const observed = await until(state, 1500);
      assert.ok(observed && Date.now() - observed.snapshotAt < 1000, 'Each sequence batch requires a fresh fixture snapshot');
      assert.equal(observed.foregroundPid, observed.pid, 'Sequence batches run only while the disposable fixture owns the foreground');
      const answers = await Promise.all(Array.from({ length: 64 }, () => remote.request('click', { x: -1, y: .5 })));
      assert.ok(answers.every(answer => answer.error));
    }
    assert.equal(remote.ws.readyState, WebSocket.OPEN);
    assert.equal((await remote.input('text', { text: 'SEQUENCE_STILL_ACTIVE' })).error, undefined);
    await until(async () => (await state())?.text === 'SEQUENCE_STILL_ACTIVE');
  });
  await check('explicit authorized clipboard set/get round-trips Unicode and restores prior text', async () => {
    const clipboard = async (tool, args) => {
      let response;
      for (let retry = 0; retry < 8; retry++) {
        response = await remote.input(tool, args);
        if (!response.error?.includes('正被其他程序使用')) return response;
        await pause(150);
      }
      return response;
    };
    const saved = await clipboard('clipboard_get', {}); assert.equal(saved.error, undefined);
    const original = saved.result.text;
    try {
      assert.equal((await clipboard('clipboard_set', { text: 'NexusRoom 剪贴板验收 🚀' })).error, undefined);
      const received = await clipboard('clipboard_get', {}); assert.equal(received.error, undefined);
      assert.equal(received.result.text, 'NexusRoom 剪贴板验收 🚀');
      const large = '中'.repeat(65536);
      assert.equal((await clipboard('clipboard_set', { text: large })).error, undefined);
      const full = await clipboard('clipboard_get', {}); assert.equal(full.error, undefined);
      assert.ok(full.result.text === large, '65536 Chinese characters must round-trip without closing the socket');
    } finally {
      const restored = await clipboard('clipboard_set', { text: original });
      assert.ok(!restored.error, 'Could not restore original clipboard text');
    }
  });
  await check('local clipboard bridge writes Windows text without the OLE path', async () => {
    const original = await remote.input('clipboard_get', {}); assert.equal(original.error, undefined);
    try {
      await api('/api/clipboard', { text: 'NexusRoom 旧桥接验收 🚀' });
      await until(async () => {
        const received = await remote.input('clipboard_get', {});
        return !received.error && received.result.text === 'NexusRoom 旧桥接验收 🚀';
      }, 4000);
    } finally {
      const restored = await remote.input('clipboard_set', { text: original.result.text });
      assert.equal(restored.error, undefined, 'Could not restore original clipboard text');
    }
  });
  await check('PC Agent cannot run in another room while a remote session owns the desktop', async () => {
    const profile = await api('/api/settings/profiles', { name: 'PC conflict fixture', apiType: 'chat_completions', apiUrl: 'https://api.example.test/v1', apiKey: 'contract-key', model: 'fixture' }, undefined, room2.id);
    const result = await local('/api/agent/runs', { targetId: 'pc:' + room2.id, task: 'hold', mode: 'automatic', profileId: profile.id, workspacePath: data }, undefined, room2.id);
    assert.equal(result.status, 409);
  });
  await check('permission changes and local Stop release held mouse buttons and restore online state', async () => {
    const before = await state(); const panel = coordinate(before.panel, before);
    await remote.input('pointer', { ...panel, action: 'down', button: 'left' }); await until(async () => (await state())?.down > before.down);
    const up = (await state()).up;
    await api('/api/pc/remote/permissions', { ...grants, control: false });
    await until(async () => (await state())?.up > up);
    assert.equal((await device('/device/pc/status', member)).session, null);
    assert.equal((await api('/api/state')).host.activity, 'online');
    remote = await startRemote(member, roomId, { audio: false });
    assert.ok((await remote.input('text', { text: 'must not execute' })).error);
    await api('/api/pc/remote/stop', {});
    assert.equal((await device('/device/pc/status', member)).session, null);
    await api('/api/pc/remote/permissions', grants);
  });
  await check('screen and clipboard remain separate grants and revoked membership closes an active stream', async () => {
    await api('/api/pc/remote/permissions', { ...grants, clipboard: false });
    remote = await startRemote(member, roomId, { audio: false });
    assert.ok((await remote.input('clipboard_get', {})).error);
    await api('/api/pc/remote/permissions', { ...grants, screen: false });
    assert.equal((await device('/device/pc/status', member)).session, null);
    assert.equal((await mobile('/device/pc/start', member, {})).status, 403);
    await api('/api/pc/remote/permissions', grants);
    remote = await startRemote(member, roomId, { audio: false });
    await api('/api/devices/' + member.deviceId, undefined, 'DELETE');
    await until(() => remote.ws.readyState === WebSocket.CLOSED);
    assert.equal((await mobile('/device/pc/status', member)).status, 401);
    assert.equal((await api('/api/state')).host.activity, 'online');
  });
  await check('approved sessions expire without connecting and abandoned room links release requests', async () => {
    pending = await device('/device/pc/start', peer, {});
    await api('/api/pc/remote/decision', { sessionId: pending.sessionId, allow: true });
    await until(async () => !(await device('/device/pc/status', peer)).session, 13000);
    pending = await device('/device/pc/start', peer, {});
    const peerLink = sockets.find(s => s.url.endsWith('/device/ws') && s !== link && s.readyState === WebSocket.OPEN);
    peerLink.terminate();
    await until(async () => (await api('/api/pc/remote/status')).session === null);
  });
  await check('duplicate or malformed sequences, protocol changes and legacy duplicate IDs close the session without replay', async () => {
    // peer's link was deliberately abandoned above. A new same-room member
    // keeps this check independent of that disconnected identity.
    const finalMember = await device('/device/join', null, { roomId, password: invite.password, name: 'Sequence regression phone', version: release.version });
    await joinLink(finalMember);
    await until(async () => (await api('/api/state')).devices.some(d => d.id === finalMember.deviceId && d.online));
    for (const variant of ['stale', 'downgrade', 'legacy', 'upgrade', 'non-number', 'fractional', 'unsafe', 'zero']) {
      const active = await startRemote(finalMember, roomId, { audio: false }, variant === 'legacy' || variant === 'upgrade');
      const observed = await state(); focusFixture(observed.pid, observed.hwnd);
      await until(async () => { const snapshot = await state(); return snapshot?.foreground && snapshot.focused; });
      const first = await active.request('click', { x: -1, y: .5 }, { id: 'replay-check' });
      assert.ok(first.error);
      const beforeText = (await state()).text;
      const replay = variant === 'legacy' ? { id: 'replay-check' }
        : variant === 'stale' ? { seq: 1 }
        : variant === 'downgrade' ? { seq: undefined }
        : variant === 'non-number' ? { seq: '2' }
        : variant === 'fractional' ? { seq: 1.5 }
        : variant === 'unsafe' ? { seq: 9007199254740992 }
        : variant === 'zero' ? { seq: 0 }
        : { seq: 1 };
      // Any replay regression can affect only the focused disposable textbox;
      // its text must remain unchanged after the rejected stream closes.
      active.ws.send(JSON.stringify({ type: 'input', id: variant === 'legacy' ? 'replay-check' : 'replay-new-id',
        tool: 'text', arguments: { text: 'MUST_NOT_REPLAY' }, ...replay }));
      await until(() => active.ws.readyState === WebSocket.CLOSED);
      await until(async () => (await device('/device/pc/status', finalMember)).session === null);
      assert.equal((await api('/api/state')).host.activity, 'online');
      assert.equal((await state()).text, beforeText, variant);
    }
  });
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ checks, realDesktopCapture: true, realLoopbackAudio: true, realWindowsInput: true, roomIsolation: true, revocation: true, cleanup: true }, null, 2));
  console.log(checks + ' PC remote contract checks passed; evidence: ' + evidence);
} catch (error) {
  console.error(error.stack); console.error(diagnostics.slice(-2000)); process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.terminate();
  if (fixture) try {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixtureLauncher,
      '-Stop', '-ProcessId', String(fixture.pid), '-StartTimeTicks', fixture.startTimeTicks],
    { windowsHide: true, timeout: 10000, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) { console.error('Owned fixture cleanup failed:', error.stderr?.toString() || error.message); process.exitCode = 1; }
  child.kill();
  await pause(300);
}
