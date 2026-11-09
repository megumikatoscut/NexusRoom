import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import dgram from 'node:dgram';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = JSON.parse(await readFile(resolve(root, 'release.json'), 'utf8'));
await mkdir(resolve(root, '.local'), { recursive: true });
const data = await mkdtemp(resolve(root, '.local', 'host-regression-v' + release.version + '-'));
const workspace = resolve(data, '工作目录 with spaces');
await mkdir(resolve(workspace, 'child'), { recursive: true });
await writeFile(resolve(workspace, 'file.txt'), 'fixture');
const ports = { ui: 18590, device: 18591, discovery: 18592 };
const hostExecutable = process.env.NEXUS_TEST_HOST;
const child = spawn(hostExecutable || 'dotnet', hostExecutable ? ['--headless'] : [resolve(root, 'src/NexusRoom.Host/bin/Debug/net10.0-windows/NexusRoom.Host.dll'), '--headless'], {
  cwd: root, windowsHide: true, env: { ...process.env, NEXUS_DATA_DIR: data, NEXUS_UI_PORT: String(ports.ui), NEXUS_DEVICE_PORT: String(ports.device), NEXUS_DISCOVERY_PORT: String(ports.discovery), NEXUS_DISABLE_MDNS: process.env.NEXUS_TEST_MDNS === '1' ? '0' : '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let diagnostic = ''; child.stdout.on('data', chunk => { diagnostic += chunk; }); child.stderr.on('data', chunk => { diagnostic += chunk; });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 15000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return; await wait(100); } throw new Error('Host condition timed out'); }
let admin, fingerprint, device, socket;
let receivedCommands = [];
let passed = 0;
async function check(name, action) { await action(); passed++; console.log('PASS ' + name); }
async function host(path, body, method = body === undefined ? 'GET' : 'POST', token = admin) {
  const response = await fetch(`http://127.0.0.1:${ports.ui}` + path, { method, headers: { Authorization: `Bearer ${token}`, 'X-Nexus-Request': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, value: await response.json() };
}
async function mobile(path, body, token = '', method = body === undefined ? 'GET' : 'POST') {
  return new Promise((resolve, reject) => {
    const request = https.request(`https://127.0.0.1:${ports.device}` + path, { method, rejectUnauthorized: false, agent: false,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, response => {
      try { assert.equal(createHash('sha256').update(response.socket.getPeerCertificate().raw).digest('hex'), fingerprint); }
      catch (error) { response.destroy(); reject(error); return; }
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, value: JSON.parse(Buffer.concat(chunks)) }));
    });
    request.on('error', reject); if (body !== undefined) request.write(JSON.stringify(body)); request.end();
  });
}
function protectedJson(filename) {
  const path = resolve(data, filename).replaceAll("'", "''");
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes('${path}'),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))`], { encoding: 'utf8', windowsHide: true }).trim());
}
function permissions(agent) { socket.send(JSON.stringify({ type: 'hello', permissions: { agent } })); }
function mdnsQuery(interfaceAddress) {
  const labels = '_nexusroom._tcp.local'.split('.').map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]));
  const header = Buffer.alloc(12); header.writeUInt16BE(1, 4);
  const packet = Buffer.concat([header, ...labels, Buffer.from([0, 0, 12, 0, 1])]);
  return new Promise((resolve, reject) => {
    const udp = dgram.createSocket('udp4');
    const timeout = setTimeout(() => { udp.close(); reject(new Error('mDNS response timeout')); }, 5000);
    udp.on('error', error => { clearTimeout(timeout); udp.close(); reject(error); });
    udp.on('message', response => {
      if (!response.includes(Buffer.from('fingerprint=' + fingerprint))) return;
      clearTimeout(timeout); udp.close();
      let offset = 12; const ips = [];
      const skipName = () => {
        while (response[offset]) {
          if ((response[offset] & 0xc0) === 0xc0) { offset += 2; return; }
          offset += response[offset] + 1;
        }
        offset++;
      };
      for (let i = 0; i < response.readUInt16BE(4); i++) { skipName(); offset += 4; }
      for (let i = 0; i < response.readUInt16BE(6); i++) {
        skipName(); const type = response.readUInt16BE(offset); const length = response.readUInt16BE(offset + 8); offset += 10;
        if (type === 1 && length === 4) ips.push([...response.subarray(offset, offset + 4)].join('.'));
        offset += length;
      }
      resolve(ips.sort());
    });
    udp.bind(0, interfaceAddress, () => {
      udp.setMulticastInterface(interfaceAddress);
      udp.send(packet, 5353, '224.0.0.251');
    });
  });
}
async function connect() {
  socket = new WebSocket(`wss://127.0.0.1:${ports.device}/device/ws`, { rejectUnauthorized: false, headers: { Authorization: `Bearer ${device.token}` } });
  const current = socket;
  current.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type !== 'command') return;
    receivedCommands.push(message);
    if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: 'result', id: message.id,
      result: message.tool === 'agent_start' ? { accepted: true, taskId: message.arguments.taskId } : { ok: true } }));
  });
  await once(socket, 'open');
  assert.equal(createHash('sha256').update(socket._socket.getPeerCertificate().raw).digest('hex'), fingerprint);
  permissions(true);
  await until(async () => (await host('/api/state')).value.devices.some(d => d.id === device.deviceId && d.online && d.permissions.agent));
}
try {
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${ports.ui}/health`)).ok; } catch { return false; } });
  admin = new URL(protectedJson('launch.dat')).hash.split('=')[1];
  const invitation = (await host('/api/invitation')).value; fingerprint = invitation.fingerprint;
  if (process.env.NEXUS_TEST_MDNS === '1') await check('mDNS advertises current addresses and keeps responding after interface refresh timeout', async () => {
    const addresses = (await host('/api/state')).value.host.addresses.map(address => new URL(address).hostname).sort();
    assert.ok(addresses.length > 0, 'mDNS test requires an active LAN adapter');
    assert.deepEqual(await mdnsQuery(addresses[0]), addresses);
    await wait(2500);
    assert.deepEqual(await mdnsQuery(addresses[0]), addresses);
  });
  await check('workspace listings require host session and pinned device credentials', async () => {
    assert.equal((await host('/api/agent/workspace', undefined, 'GET', '')).status, 401);
    assert.equal((await mobile('/device/agent/workspace')).status, 401);
  });
  await check('host folder picker opens user directory and enumerates drive roots', async () => {
    const result = await host('/api/agent/workspace'); assert.equal(result.status, 200);
    assert.equal(result.value.path, result.value.defaultPath);
    assert.ok(result.value.roots.some(d => d.path.toLowerCase() === parse(workspace).root.toLowerCase()));
    assert.equal(typeof result.value.truncated, 'boolean');
  });
  await check('workspace lists files and folders with metadata, preserves Unicode/spaces and navigates parent', async () => {
    const result = await host('/api/agent/workspace?path=' + encodeURIComponent(workspace)); assert.equal(result.status, 200);
    assert.equal(result.value.path, workspace); assert.equal(result.value.parentPath, data);
    assert.deepEqual(result.value.directories, [{ name: 'child', path: resolve(workspace, 'child') }]);
    assert.ok(Array.isArray(result.value.files), 'workspace response must include files');
    assert.equal(result.value.files.length, 1);
    assert.equal(result.value.files[0].name, 'file.txt');
    assert.equal(result.value.files[0].path, resolve(workspace, 'file.txt'));
    assert.equal(result.value.files[0].size, 7);
    assert.ok(Number.isFinite(Date.parse(result.value.files[0].modifiedAt)));
    const filtered = await host('/api/agent/workspace?path=' + encodeURIComponent(workspace) + '&query=FILE.TXT');
    assert.equal(filtered.value.files.length, 1);
    assert.equal(filtered.value.directories.length, 0);
    assert.equal((await host('/api/agent/workspace?path=' + encodeURIComponent(resolve(workspace, 'child')))).value.parentPath, workspace);
    assert.equal((await host('/api/agent/workspace?path=' + encodeURIComponent(parse(workspace).root))).value.parentPath, null);
  });
  await check('folder picker rejects relative, malformed, missing and file paths with clear 400', async () => {
    for (const path of ['child', 'C:relative', 'C:\\bad|path', resolve(workspace, 'missing'), resolve(workspace, 'file.txt')]) {
      const result = await host('/api/agent/workspace?path=' + encodeURIComponent(path));
      assert.equal(result.status, 400, path); assert.equal(typeof result.value.title, 'string');
    }
  });
  await check('folder name search reaches directories beyond the 1000-entry limit', async () => {
    const many = resolve(data, 'many-folders');
    const names = Array.from({ length: 1005 }, (_, i) => 'archive-' + String(i).padStart(4, '0'));
    await mkdir(many);
    for (let i = 0; i < names.length; i += 100)
      await Promise.all(names.slice(i, i + 100).map(name => mkdir(resolve(many, name))));
    const path = '?path=' + encodeURIComponent(many);
    const initial = await host('/api/agent/workspace' + path); assert.equal(initial.status, 200);
    assert.equal(initial.value.directories.length, 1000); assert.equal(initial.value.truncated, true);
    const listed = new Set(initial.value.directories.map(directory => directory.name));
    const missing = names.find(name => !listed.has(name)); assert.ok(missing);
    const filtered = await host('/api/agent/workspace' + path + '&query=' + encodeURIComponent(missing.toUpperCase()));
    assert.equal(filtered.status, 200); assert.equal(filtered.value.truncated, false);
    assert.deepEqual(filtered.value.directories, [{ name: missing, path: resolve(many, missing) }]);
    assert.equal(filtered.value.path, many); assert.equal(filtered.value.parentPath, data);
    assert.equal((await host('/api/agent/workspace' + path + '&query=' + 'x'.repeat(101))).status, 400);
    assert.equal((await host('/api/agent/workspace' + path + '&query=' + encodeURIComponent('bad\nquery'))).status, 400);
  });
  device = (await mobile('/device/join', { roomId: invitation.roomId, password: invitation.password, name: 'Workspace regression device', version: release.version, physicalId: 'regression-device' })).value;
  await connect();
  await check('Android folder picker uses the same host directories and requires Agent permission', async () => {
    const result = await mobile('/device/agent/workspace?path=' + encodeURIComponent(workspace), undefined, device.token);
    assert.equal(result.status, 200); assert.deepEqual(result.value, (await host('/api/agent/workspace?path=' + encodeURIComponent(workspace))).value);
    permissions(false); await until(async () => !(await host('/api/state')).value.devices[0].permissions.agent);
    assert.equal((await mobile('/device/agent/workspace', undefined, device.token)).status, 403);
    permissions(true); await until(async () => (await host('/api/state')).value.devices[0].permissions.agent);
    await host('/api/settings/pc-agent', { enabled: false });
    assert.equal((await mobile('/device/agent/workspace', undefined, device.token)).status, 403);
    await host('/api/settings/pc-agent', { enabled: true });
  });
  await check('paused admission remains discoverable and existing token verifies stable host/room identity', async () => {
    await host('/api/room/access', { open: false });
    const discovery = await mobile('/device/discovery'); assert.equal(discovery.status, 200);
    const room = discovery.value.find(r => r.roomId === invitation.roomId); assert.equal(room.open, false); assert.equal(room.fingerprint, fingerprint);
    const udp = dgram.createSocket('udp4');
    try { udp.send('NEXUSROOM_DISCOVER_V1', ports.discovery, '127.0.0.1'); const [message] = await Promise.race([once(udp, 'message'), wait(3000).then(() => { throw new Error('UDP discovery timeout'); })]); const response = JSON.parse(message); assert.equal(response.roomId, invitation.roomId); assert.equal(response.open, false); assert.equal(response.fingerprint, fingerprint); }
    finally { udp.close(); }
    const verified = await mobile('/device/room', undefined, device.token); assert.equal(verified.status, 200);
    assert.equal(verified.value.roomId, invitation.roomId); assert.equal(verified.value.id, invitation.roomId); assert.equal(verified.value.fingerprint, fingerprint); assert.ok(verified.value.hostName);
    assert.equal((await mobile('/device/join', { roomId: invitation.roomId, password: invitation.password, name: 'Blocked newcomer', version: release.version })).status, 403);
    socket.terminate(); await once(socket, 'close'); await connect();
    assert.equal((await host('/api/state')).value.devices.filter(d => !d.revoked).length, 1);
  });
  const draft = { name: 'First profile', apiType: 'chat_completions', apiUrl: 'https://api.example.test/v1', model: 'fixture', apiKey: 'first-fixture-key' };
  const first = (await host('/api/settings/profiles', draft)).value;
  const second = (await host('/api/settings/profiles', { ...draft, name: 'Second profile', apiKey: 'second-fixture-key' })).value;
  await check('PUT and PATCH require the mutation header and rejected writes leave saved profiles unchanged', async () => {
    const before = (await host('/api/settings')).value;
    for (const method of ['PUT', 'PATCH']) {
      const response = await fetch(`http://127.0.0.1:${ports.ui}/api/settings/profiles/${first.id}`, {
        method, headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draft, name: 'Must not save', model: 'must-not-save' })
      });
      assert.equal(response.status, 403, method);
      assert.match((await response.json()).title, /校验头/);
      assert.deepEqual((await host('/api/settings')).value, before);
    }
    assert.equal((await host(`/api/settings/profiles/${first.id}`, { ...draft, apiKey: '' }, 'PUT')).status, 200);
    assert.deepEqual((await host('/api/settings')).value, before);
  });
  await check('saving another model profile with empty key retains that profile key', async () => {
    assert.equal((await host('/api/settings', { ...draft, profileId: first.id })).status, 200);
    assert.equal((await host('/api/settings', { ...draft, profileId: second.id, apiKey: '' })).status, 200);
    const saved = protectedJson('state.dat').rooms[0];
    assert.equal(saved.agentProfiles.find(p => p.id === second.id).apiKey, 'second-fixture-key');
    assert.equal(saved.agent.apiKey, 'second-fixture-key');
  });
  await check('rejected stale or malformed model settings leave all settings unchanged', async () => {
    const before = (await host('/api/settings')).value;
    assert.equal((await host('/api/settings', { ...draft, profileId: 'stale-profile-id', model: 'must-not-save', pcAgentEnabled: false })).status, 409);
    assert.deepEqual((await host('/api/settings')).value, before);
    assert.equal((await host('/api/settings', { ...draft, profileId: second.id, pcAgentEnabled: 'invalid' })).status, 400);
    assert.deepEqual((await host('/api/settings')).value, before);
    assert.equal((await host(`/api/settings/profiles/${second.id}`, { ...draft, apiKey: 'x'.repeat(1025) }, 'PUT')).status, 400);
    assert.deepEqual((await host('/api/settings')).value, before);
    assert.equal((await host('/api/settings/profiles', { ...draft, name: null })).status, 400);
  });
  await check('invalid PC cwd fails before a Harness process or run is created', async () => {
    const result = await host('/api/agent/runs', { targetId: 'pc:' + invitation.roomId, task: 'fixture', mode: 'request', profileId: first.id, workspacePath: 'child' });
    assert.equal(result.status, 400); assert.deepEqual((await host('/api/agent/runs')).value, []);
  });
  await check('a broken phone connection cancels its active run and clears old leases before rejoining', async () => {
    const request = { targetId: device.deviceId, task: 'Wait for regression fixture', mode: 'automatic', profileId: first.id };
    const started = await host('/api/agent/runs', request); assert.equal(started.status, 200);
    await until(() => receivedCommands.some(c => c.tool === 'agent_start' && c.arguments.taskId === started.value.id));
    socket.terminate(); await once(socket, 'close');
    await until(async () => (await host('/api/agent/runs')).value.find(r => r.id === started.value.id)?.status === 'cancelled');
    await connect();
    const state = (await host('/api/state')).value;
    assert.equal(state.devices[0].activity, 'online'); assert.equal(state.devices[0].ownerRoom, '');
    assert.deepEqual(state.media.pending, []);
    receivedCommands = [];
    const again = await host('/api/agent/runs', request); assert.equal(again.status, 200);
    await until(() => receivedCommands.some(c => c.tool === 'agent_start' && c.arguments.taskId === again.value.id));
    assert.equal((await host('/api/agent/runs/' + again.value.id, undefined, 'DELETE')).status, 200);
    await until(async () => (await host('/api/agent/runs')).value.find(r => r.id === again.value.id)?.status === 'cancelled');
  });
  console.log(`Host v${release.version} regression: ${passed} checks passed.`);
} catch (error) {
  console.error(diagnostic.replaceAll('first-fixture-key', '[REDACTED]').replaceAll('second-fixture-key', '[REDACTED]'));
  throw error;
} finally {
  socket?.terminate();
  if (child.exitCode === null) execFileSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
}
