import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, rmdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import http from 'node:http';
import dgram from 'node:dgram';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import {agentModeChecks} from './agent-modes.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = resolve(root, '.local', `integration-${Date.now()}`);
await mkdir(data, { recursive: true });
const base = 'http://127.0.0.1:17990';
const executable = process.env.NEXUS_TEST_HOST;
const child = spawn(executable || 'dotnet', executable ? ['--headless'] : [resolve(root, 'src/NexusRoom.Host/bin/Debug/net10.0-windows/NexusRoom.Host.dll'), '--headless'], {
  cwd: root, windowsHide: true, env: { ...process.env, NEXUS_DATA_DIR: data, NEXUS_UI_PORT: '17990', NEXUS_DEVICE_PORT: '17991', NEXUS_DISCOVERY_PORT: '17992', NEXUS_DISABLE_MDNS: "1" }, stdio: ['ignore', 'pipe', 'pipe']
});
let logs = ''; child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
const wait = ms => new Promise(r => setTimeout(r, ms));
let admin = ''; let count = 0; const sockets = [];
async function check(name, action) { await action(); count++; console.log(`PASS ${name}`); }
async function host(path, body, token = admin, method = body === undefined ? 'GET' : 'POST', extra = {}) {
  const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'X-Nexus-Request': '1', 'Content-Type': 'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await response.text(); let value; try { value = JSON.parse(raw); } catch { value = raw; } return { status: response.status, value, headers: response.headers };
}
// The isolated test server's generated self-signed certificate is pinned for all authenticated requests.
let fingerprint;
const mobileAgent = new https.Agent({keepAlive:false, maxCachedSessions:0});
async function mobile(path, body, token = '', method = body === undefined ? 'GET' : 'POST', extra = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(`https://127.0.0.1:17991${path}`, { method, agent:mobileAgent, rejectUnauthorized: false, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra } }, response => {
      const peer = response.socket.getPeerCertificate();
      if (fingerprint && createHash('sha256').update(peer.raw).digest('hex') !== fingerprint) { response.destroy(); reject(new Error('Certificate pin mismatch')); return; }
      const chunks = []; response.on('data', b => chunks.push(b)); response.on('end', () => { const raw = Buffer.concat(chunks); let value; try { value = JSON.parse(raw.toString()); } catch { value = raw; } resolve({ status: response.statusCode, value, headers: response.headers }); });
    }); req.on('error', reject); if (body !== undefined) req.write(Buffer.isBuffer(body) ? body : JSON.stringify(body)); req.end();
  });
}
function connect(device, permissions = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://127.0.0.1:17991/device/ws', { rejectUnauthorized: false, headers: { Authorization: `Bearer ${device.token}` } }); sockets.push(ws);
    ws.on('error', reject); const received = [];
    const state = { ws, received, downloads: [], agentHandler: null };
    ws.on('open', () => {
      const peer = ws._socket.getPeerCertificate(); assert.equal(createHash('sha256').update(peer.raw).digest('hex'), fingerprint);
      ws.send(JSON.stringify({ type: 'hello', battery: 74, width: 1080, height: 1920, permissions })); resolve(state);
    });
    ws.on('message', async data => {
      const message = JSON.parse(data.toString()); if (message.type !== 'command') return; received.push(message);
      if (message.tool === 'agent_start' || message.tool === 'agent_cancel' || message.tool === 'agent_approve') {
        if (state.agentHandler) { state.agentHandler(message); return; }
        const result = message.tool === 'agent_start' ? { accepted: true, taskId: message.arguments?.taskId } : { ok: true };
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'result', id: message.id, result }));
        return;
      }
      let result = { ok: true };
      if (message.tool === 'receive_file') {
        const download = await mobile(`/device/files/${message.arguments.fileId}`, undefined, device.token);
        assert.equal(download.status, 200);
        state.downloads.push({fileId: message.arguments.fileId, bytes: Buffer.from(download.value)});
        result = { sha256: createHash('sha256').update(download.value).digest('hex') };
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'result', id: message.id, result }));
      });
      return state;
  });
}
async function until(predicate, timeout = 5000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await predicate()) return; await wait(100); } throw new Error('Condition timed out'); }
try {
  await until(async () => { try { return (await fetch(base + '/health')).ok; } catch { return false; } }, 15000);
  const launchPath = resolve(data, 'launch.dat').replaceAll("'", "''");
  const script = `[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes('${launchPath}'),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))`;
  const launch = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Security; ${script}`], { encoding: 'utf8', windowsHide: true }).trim());
  admin = new URL(launch).hash.split('=')[1];
  await check('release starts with a fresh room and no devices, transfers, approvals or configured model', async () => {
    const release = JSON.parse(await readFile(resolve(root, 'release.json'), 'utf8'));
    assert.equal((await host('/health')).value.version, release.version);
    const state = (await host('/api/state')).value;
    assert.equal(state.rooms.length, 1);
    assert.deepEqual(state.devices, []);
    assert.deepEqual(state.transfers, []);
    assert.deepEqual(state.approvals, []);
    const settings = (await host('/api/settings')).value;
    assert.equal(settings.hasKey, false);
    assert.equal(settings.model, '');
    assert.equal(settings.apiUrl, 'https://api.openai.com/v1');
    assert.equal(settings.profiles.length, 1);
    assert.equal(settings.profiles[0].model, '');
    assert.equal(settings.profiles[0].hasKey, false);
    assert.deepEqual((await host('/api/agent/runs')).value, []);
  });
  await check('admin APIs reject missing credentials and case variants', async () => { for (const p of ['/api/state', '/API/state', '/api/invitation']) assert.equal((await host(p, undefined, '')).status, 401); });
  await check('LAN listener never exposes host admin API', async () => { assert.equal((await mobile('/api/state', undefined, admin)).status, 403); });
  await check('origin and Host validation prevent cross-site access', async () => {
    assert.equal((await host('/api/state', undefined, admin, 'GET', { Origin: 'https://untrusted.example' })).status, 403);
    const status = await new Promise((resolve, reject) => { const req = http.get(base + '/api/state', { headers: { Host: 'untrusted.example', Authorization: `Bearer ${admin}` } }, response => { response.resume(); resolve(response.statusCode); }); req.on('error', reject); });
    assert.equal(status, 403);
  });
  const invitation = (await host('/api/invitation')).value; fingerprint = invitation.fingerprint;
  await check('room discovery advertises identity without password or token', async () => {
    const socket = dgram.createSocket('udp4'); try { socket.send('NEXUSROOM_DISCOVER_V1', 17992, '127.0.0.1'); const [message] = await Promise.race([once(socket, 'message'), wait(3000).then(() => { throw new Error('Discovery timeout'); })]); const result = JSON.parse(message); assert.equal(result.roomId, invitation.roomId); assert.equal(result.fingerprint, fingerprint); assert.equal(result.password, undefined); assert.equal(result.token, undefined); } finally { socket.close(); }
  });
  await check('wrong room password cannot join', async () => assert.equal((await mobile('/device/join', { roomId: invitation.roomId, password: 'wrong', name: 'QA', version: '12' })).status, 401));
  const device = (await mobile('/device/join', { roomId: invitation.roomId, password: invitation.password, name: 'QA protocol device', version: '12' })).value;
  const second = (await mobile('/device/join', { roomId: invitation.roomId, password: invitation.password, name: 'QA second device', version: '14' })).value;
  await check('room model profiles support Android create, explicit update, shared default, delete and secret-safe listing', async () => {
    const before = (await mobile('/device/room', undefined, device.token)).value;
    const originalId = before.defaultProfileId;
    const initialCount = before.profiles.length;
    const create = await mobile('/device/room/profiles', { createNew: true, name: 'Android QA', apiType: 'chat_completions', apiUrl: 'https://api.example.test/v1', model: 'qa-model', apiKey: 'profile-secret', maxCalls: 12, maxSteps: 10, timeoutSeconds: 120 }, device.token);
    assert.equal(create.status, 200);
    const profileId = create.value.id;
    assert.ok(profileId && profileId !== originalId);
    let roomProfiles = (await mobile('/device/room', undefined, device.token)).value;
    assert.equal(roomProfiles.profiles.length, initialCount + 1);
    assert.equal(roomProfiles.profiles.some(profile => profile.apiKey === 'profile-secret'), false);
    assert.equal(JSON.stringify(roomProfiles).includes('profile-secret'), false);
    const update = await mobile('/device/room/profiles', { profileId, name: 'Android QA Updated', apiType: 'responses', apiUrl: 'https://api.example.test/v1', model: 'qa-model-2', apiKey: '', maxCalls: 15, maxSteps: 11, timeoutSeconds: 180 }, device.token);
    assert.equal(update.status, 200);
    assert.equal(update.value.id, profileId);
    roomProfiles = (await mobile('/device/room', undefined, device.token)).value;
    assert.equal(roomProfiles.profiles.length, initialCount + 1);
    assert.equal(roomProfiles.profiles.find(profile => profile.id === profileId).model, 'qa-model-2');
    assert.equal((await mobile(`/device/room/profiles/${profileId}/default`, {}, device.token)).status, 200);
    assert.equal((await mobile('/device/room', undefined, device.token)).value.defaultProfileId, profileId);
    assert.equal((await mobile(`/device/room/profiles/${profileId}`, undefined, device.token, 'DELETE')).status, 200);
    roomProfiles = (await mobile('/device/room', undefined, device.token)).value;
    assert.equal(roomProfiles.profiles.length, initialCount);
    assert.equal(roomProfiles.defaultProfileId, originalId);
    assert.equal((await mobile(`/device/room/profiles/${originalId}`, undefined, device.token, 'DELETE')).status, 409);
  });
  await check('saving a selected desktop profile preserves the room default until explicitly changed', async () => {
    const originalDefault = (await host('/api/settings')).value.defaultProfileId;
    const created = await host('/api/settings/profiles', {name:'Desktop selection fixture',apiType:'chat_completions',apiUrl:'https://api.example.test/v1',model:'desktop-selection',apiKey:'desktop-selection-key'});
    assert.equal(created.status,200,JSON.stringify(created.value));
    const saved = await host('/api/settings', {profileId:created.value.id,profileName:created.value.name,apiType:created.value.apiType,apiUrl:created.value.apiUrl,model:created.value.model,apiKey:'',confirmMutations:true});
    assert.equal(saved.status,200); assert.equal((await host('/api/settings')).value.defaultProfileId,originalDefault);
    assert.equal((await host(`/api/settings/profiles/${created.value.id}`,undefined,admin,'DELETE')).status,200);
    const stale = await host('/api/settings', {profileId:created.value.id,profileName:'stale',apiType:'chat_completions',apiUrl:'https://api.example.test/v1',model:'stale',apiKey:'',confirmMutations:true});
    assert.equal(stale.status,409);
  });
  const session = await connect(device); await until(async () => (await host('/api/state')).value.devices.some(d => d.id === device.deviceId && d.online));
  await check('joining grants no remote-control or screen permission', async () => { assert.equal((await host(`/api/devices/${device.deviceId}/command`, { tool: 'tap', arguments: { x: .5, y: .5 } })).status, 403); assert.equal((await host(`/api/devices/${device.deviceId}/screenshot`)).status, 403); });
  await check('capture startup failure survives returning online and remains visible to the host', async () => {
    session.ws.send(JSON.stringify({type:'heartbeat',activity:'online',permissions:{},capture:{state:'error',stage:'encoder',error:'无法启动 H.264 编码器',encoder:'',width:0,height:0}}));
    await wait(150);
    const view=(await host('/api/state')).value.devices.find(d=>d.id===device.deviceId);
    assert.equal(view.capture?.state,'error');
    assert.equal(view.capture?.error,'无法启动 H.264 编码器');
    assert.equal(view.online,true);assert.equal(view.permissions.screen,false);
    session.ws.send(JSON.stringify({type:'heartbeat',activity:'online',capture:{state:'idle',stage:'',error:'',encoder:'',width:0,height:0}}));
    await until(async()=>(await host('/api/state')).value.devices[0].capture?.state==='idle');
  });
  session.ws.send(JSON.stringify({ type: 'permissions', permissions: { screen: true, control: true, files: true, agent: true, clipboard: false } }));
  await until(async () => (await host('/api/state')).value.devices[0].permissions.control);
  await check('control RPC delivers valid actions and correlated result', async () => { const r = await host(`/api/devices/${device.deviceId}/command`, { tool: 'tap', arguments: { x: .5, y: .6 } }); assert.equal(r.status, 200); assert.equal(r.value.ok, true); assert.equal(session.received.filter(m=>!m.tool.startsWith('control_')).at(-1).tool, 'tap'); });
  await check('out-of-range coordinates and shell tools are rejected', async () => { assert.equal((await host(`/api/devices/${device.deviceId}/command`, { tool: 'tap', arguments: { x: 5, y: .5 } })).status, 400); assert.equal((await host(`/api/devices/${device.deviceId}/command`, { tool: 'shell', arguments: { command: 'id' } })).status, 400); });
  const rawFile = Buffer.from('NexusRoom QA round-trip 你好\n');
  let fileId;
  await check('imported files retain exact content and hash', async () => {
    const response = await fetch(base + `/api/files?deviceId=${device.deviceId}`, { method: 'POST', headers: { Authorization: `Bearer ${admin}`, 'X-Nexus-Request': '1', 'X-File-Name': encodeURIComponent('../../qa.txt') }, body: rawFile });
    assert.equal(response.status, 200); const t = await response.json(); fileId = t.id; assert.equal(t.name, 'qa.txt'); assert.equal(t.sha256, createHash('sha256').update(rawFile).digest('hex')); assert.equal(t.size, rawFile.length);
  });
  await check('another device cannot download a scoped file', async () => assert.equal((await mobile(`/device/files/${fileId}`, undefined, second.token)).status, 409));
  await check('file delivery completes only after Android hash acknowledgement', async () => { assert.equal((await host(`/api/files/${fileId}/send`, { deviceId: device.deviceId })).status, 200); const t = (await host('/api/state')).value.transfers.find(f => f.id === fileId); assert.equal(t.status, 'completed'); });
  const pendingRawFile = Buffer.from('NexusRoom phone Agent pending file fixture\n');
  const pendingImport = await fetch(base + `/api/files?deviceId=${device.deviceId}`, { method: 'POST', headers: { Authorization: `Bearer ${admin}`, 'X-Nexus-Request': '1', 'X-File-Name': encodeURIComponent('agent-pending.txt') }, body: pendingRawFile });
  assert.equal(pendingImport.status, 200);
  const pendingFileId = (await pendingImport.json()).id;
  await check('Android upload checks hash and exact stored bytes', async () => { const bad = await mobile('/device/files', rawFile, device.token, 'POST', { 'X-File-Name': 'phone.txt', 'X-File-SHA256': '00' }); assert.equal(bad.status, 422); const good = await mobile('/device/files', rawFile, device.token, 'POST', { 'X-File-Name': 'phone.txt', 'X-File-SHA256': createHash('sha256').update(rawFile).digest('hex') }); assert.equal(good.status, 200); const saved = await fetch(base + `/api/files/${good.value.id}`, { headers: { Authorization: `Bearer ${admin}` } }); assert.deepEqual(Buffer.from(await saved.arrayBuffer()), rawFile); });
  const external = (await host('/api/settings/token', {})).value.token;
  await check('phone model profiles reject Host-only HTTP URLs in save and test flows', async () => {
    const room = (await mobile('/device/room', undefined, device.token)).value;
    const before = (await host('/api/settings')).value.profiles.find(profile => profile.id === room.defaultProfileId);
    const draft = {profileId:room.defaultProfileId,name:'Invalid local draft',apiType:'chat_completions',apiUrl:'http://127.0.0.1:12345/v1',model:'qa-draft',apiKey:'qa-provider-key',maxCalls:12,maxSteps:8,timeoutSeconds:120};
    assert.equal((await host('/api/settings', {apiUrl:draft.apiUrl,apiKey:'qa-provider-key',model:'qa',confirmMutations:true})).status,400);
    assert.equal((await host('/api/settings/profiles', draft)).status,400);
    assert.equal((await mobile('/device/room/profiles', {...draft,createNew:true},device.token)).status,400);
    assert.equal((await host('/api/settings/test',draft)).status,400);
    assert.equal((await mobile('/device/room/profiles/test',draft,device.token)).status,400);
    assert.equal((await host('/api/settings/profiles', {...draft,apiUrl:'https://user:secret@api.example.test/v1'})).status,400);
    assert.equal((await host('/api/settings/profiles', {...draft,apiUrl:'https://api.example.test/v1?key=secret'})).status,400);
    assert.deepEqual((await host('/api/settings')).value.profiles.find(profile => profile.id === room.defaultProfileId), before, 'rejected drafts must not change the saved profile');
  });
  await check('unknown APIs return JSON 404 instead of the UI shell', async () => { const result=await host('/api/nonexistent'); assert.equal(result.status,404); assert.equal(result.value.status,404); });
  await agentModeChecks({check,host,mobile,until,wait,device,second,session,fileId,pendingFileId,pendingRawFile});
  const secondSession = await connect(second, {screen:false, control:false, files:true, agent:true, clipboard:false, audio:false, screenAllowed:false});
  await until(async () => (await host('/api/state')).value.devices.filter(d => d.online).length >= 2);
  const remoteTasks = new Map();
  const sendRemote = value => { if (secondSession.ws.readyState === 1) secondSession.ws.send(JSON.stringify(value)); };
  secondSession.agentHandler = message => {
    const args = message.arguments ?? {};
    if (message.tool === 'agent_start') {
      const taskId = args.taskId; const state = { taskId, requestId: `remote-approval-${taskId}`, held: false };
      remoteTasks.set(taskId, state); sendRemote({type:'result', id:message.id, result:{accepted:true, taskId}});
      setTimeout(() => {
        if (!remoteTasks.has(taskId)) return;
        sendRemote({type:'agent_event', taskId, status:'accepted', event:'accepted', text:'目标手机已接收任务'});
        if (String(args.prompt ?? '').includes('cancel fixture')) { state.held=true; sendRemote({type:'agent_event', taskId, status:'progress', event:'progress', text:'等待取消'}); return; }
        if (args.mode === 'request') { state.held=true; sendRemote({type:'agent_event', taskId, status:'permission_required', event:'permission_required', tool:'click_element', requestId:state.requestId, text:'目标手机等待确认'}); return; }
        sendRemote({type:'agent_event', taskId, status:'completed', event:'completed', text:'目标手机已完成任务', result:'目标手机已完成任务'});
      }, 0);
      return;
    }
    if (message.tool === 'agent_cancel') {
      const state = remoteTasks.get(args.taskId); sendRemote({type:'result', id:message.id, result:{ok:true, taskId:args.taskId}});
      if (state) { state.held=false; sendRemote({type:'agent_event', taskId:args.taskId, status:'cancelled', event:'cancelled', text:'目标任务已取消'}); }
      return;
    }
    if (message.tool === 'agent_approve') {
      const state = remoteTasks.get(args.taskId); sendRemote({type:'result', id:message.id, result:{ok:true, taskId:args.taskId}});
      if (!state || state.requestId !== args.requestId) return;
      state.held=false; sendRemote({type:'agent_event', taskId:args.taskId, status:args.approved ? 'completed' : 'failed', event:args.approved ? 'completed' : 'failed', text:args.approved ? '目标手机已完成确认操作' : '目标手机拒绝了操作', result:args.approved ? '目标手机已完成确认操作' : undefined});
    }
  };
  await check('Agent router exposes the room PC target without changing Android device state', async () => {
    const roomId = (await host('/api/state')).value.room.id;
    const pcId = `pc:${roomId}`;
    const listed = await mobile('/device/room/devices', undefined, device.token);
    assert.equal(listed.status, 200);
    assert.ok(listed.value.some(item => item.id === device.deviceId && item.type === 'android'));
    assert.ok(listed.value.some(item => item.id === pcId && item.type === 'pc' && item.system === 'Windows' && item.online && item.agent));
    assert.equal((await host('/api/state')).value.devices.some(item => item.id === pcId), false);
    const pcRuns = await mobile(`/device/agent/runs?targetDeviceId=${encodeURIComponent(pcId)}`, undefined, device.token);
    assert.equal(pcRuns.status, 200);
    assert.deepEqual(pcRuns.value, []);
    assert.equal((await mobile('/device/agent/runs?targetDeviceId=pc%3Aother-room', undefined, device.token)).status, 403);
  });
  await check('Windows Agent switch changes PC routing without changing Android targets', async () => {
    const roomId = (await host('/api/state')).value.room.id;
    const pcId = `pc:${roomId}`;
    assert.equal((await host('/api/settings/pc-agent', { enabled: false })).status, 200);
    assert.equal((await host('/api/settings')).value.pcAgentEnabled, false);
    const listed = (await mobile('/device/room/devices', undefined, device.token)).value;
    assert.equal(listed.find(item => item.id === pcId)?.agent, false);
    assert.ok(listed.some(item => item.id === device.deviceId && item.agent));
    assert.equal((await host('/api/agent/runs', { targetId: pcId, task: 'blocked PC task', mode: 'automatic' })).status, 403);
    assert.equal((await host('/api/settings/pc-agent', { enabled: true })).status, 200);
    assert.equal((await host('/api/settings')).value.pcAgentEnabled, true);
  });
  await check('same-room phone Agent lists peer devices and starts a targeted task', async () => {
    const listed = await mobile('/device/room/devices', undefined, device.token);
    assert.equal(listed.status, 200); assert.ok(listed.value.some(item => item.id === device.deviceId && item.online)); assert.ok(listed.value.some(item => item.id === second.deviceId && item.agent && item.online));
    const ownBefore = (await mobile('/device/agent/runs', undefined, device.token)).value;
    const run = await mobile('/device/agent/runs', {task:'remote approval fixture', mode:'request', targetDeviceId:second.deviceId}, device.token);
    assert.equal(run.status, 200, JSON.stringify(run.value)); assert.equal(run.value.deviceId, second.deviceId); assert.ok(!ownBefore.some(item => item.id === run.value.id));
    await until(async () => { const value=(await mobile(`/device/agent/runs?targetDeviceId=${second.deviceId}`, undefined, device.token)).value.find(item=>item.id===run.value.id); return value?.events.some(item=>(item.kind??item.Kind)==='permission_required'); });
    const current=(await mobile(`/device/agent/runs?targetDeviceId=${second.deviceId}`, undefined, device.token)).value.find(item=>item.id===run.value.id); const approvalEvent=current.events.find(item=>(item.kind??item.Kind)==='permission_required');
    assert.equal((await mobile('/device/agent/approve',{taskId:run.value.id,requestId:approvalEvent.requestId,approved:true},device.token)).status,200);
    await until(async () => (await mobile(`/device/agent/runs?targetDeviceId=${second.deviceId}`, undefined, device.token)).value.find(item=>item.id===run.value.id)?.status === 'completed');
  });
  await check('same-room phone Agent can cancel a peer task', async () => {
    const run = await mobile('/device/agent/runs', {task:'remote cancel fixture', mode:'automatic', targetDeviceId:second.deviceId}, device.token);
    assert.equal(run.status, 200); await until(async () => remoteTasks.get(run.value.id)?.held === true);
    assert.equal((await mobile(`/device/agent/runs/${run.value.id}`, undefined, device.token, 'DELETE')).status, 200);
    await until(async () => (await mobile(`/device/agent/runs?targetDeviceId=${second.deviceId}`, undefined, device.token)).value.find(item=>item.id===run.value.id)?.status === 'cancelled');
    assert.ok(secondSession.received.some(item=>item.tool==='agent_cancel' && item.arguments?.taskId===run.value.id));
  });
  await check('peer Agent rejects offline or unauthorized targets', async () => {
    secondSession.ws.send(JSON.stringify({type:'permissions',permissions:{screen:false,control:false,files:true,agent:false,clipboard:false,screenAllowed:false}}));
    await until(async () => !(await host('/api/state')).value.devices.find(item=>item.id===second.deviceId)?.permissions.agent);
    assert.equal((await mobile('/device/agent/runs',{task:'unauthorized peer',targetDeviceId:second.deviceId},device.token)).status,403);
    secondSession.ws.send(JSON.stringify({type:'permissions',permissions:{screen:false,control:false,files:true,agent:true,clipboard:false,screenAllowed:false}}));
    await until(async () => (await host('/api/state')).value.devices.find(item=>item.id===second.deviceId)?.permissions.agent);
    secondSession.ws.terminate(); await until(async () => !(await host('/api/state')).value.devices.find(item=>item.id===second.deviceId)?.online);
    assert.equal((await mobile('/device/agent/runs',{task:'offline peer',targetDeviceId:second.deviceId},device.token)).status,409);
  });
  await check('external Agent mutation waits for a specific approval', async () => {
    const before = session.received.length;
    const action = host(`/agent/v1/devices/${device.deviceId}/actions`, { tool: 'home', arguments: {} }, external);
    await until(async () => (await host('/api/state')).value.approvals.length === 1);
    assert.equal(session.received.length, before);
    const approval = (await host('/api/state')).value.approvals[0]; assert.equal(approval.tool, 'home');
    await host(`/api/approvals/${approval.id}`, { allow: true }); assert.equal((await action).status, 200); assert.equal(session.received.filter(m=>!m.tool.startsWith('control_')).at(-1).tool, 'home');
    assert.equal((await host(`/api/approvals/${approval.id}`, { allow: true })).status, 404);
  });
  await check('permission revoked during pending approval prevents execution', async () => {
    const before = session.received.length;
    const action = host(`/agent/v1/devices/${device.deviceId}/actions`, { tool: 'back', arguments: {} }, external);
    await until(async () => (await host('/api/state')).value.approvals.length === 1);
    const approval = (await host('/api/state')).value.approvals[0];
    session.ws.send(JSON.stringify({ type: 'permissions', permissions: { screen: true, control: false, files: false, agent: false } }));
    await until(async () => !(await host('/api/state')).value.devices[0].permissions.agent);
    await host(`/api/approvals/${approval.id}`, { allow: true }); assert.equal((await action).status, 403); assert.equal(session.received.length, before);
  });
  await check('revoked file and clipboard permissions block operations', async () => { assert.equal((await mobile('/device/files', rawFile, device.token, 'POST', { 'X-File-Name': 'blocked.txt' })).status, 403); assert.equal((await host(`/api/devices/${device.deviceId}/command`, { tool: 'clipboard_set', arguments: { text: 'must not copy' } })).status, 403); });
  await check('rotated invitation invalidates old password without dropping devices', async () => { await host('/api/room/rotate', {}); assert.equal((await mobile('/device/join', { roomId: invitation.roomId, password: invitation.password, name: 'QA old invite', version: '12' })).status, 401); assert.equal((await host('/api/state')).value.devices[0].online, true); });
  await check('device revocation prevents future authenticated requests', async () => { await host(`/api/devices/${device.deviceId}`, undefined, admin, 'DELETE'); assert.equal((await mobile('/device/files', rawFile, device.token, 'POST', { 'X-File-Name': 'revoked.txt' })).status, 401); });
  await check('audit and encrypted state do not expose connection secrets', async () => { const audit = await readFile(resolve(data, 'audit.jsonl'), 'utf8'); assert.ok(!audit.includes(device.token)); assert.ok(!audit.includes(invitation.password)); const vault = await readFile(resolve(data, 'state.dat')); assert.ok(!vault.includes(Buffer.from(invitation.password))); });
  await check('multiple rooms keep membership, settings and file lists isolated', async () => {
    const room = (await host('/api/rooms', {name:'第二个房间'})).value;
    assert.ok(room.id && room.id !== invitation.roomId);
    const header={'X-Nexus-Room':room.id};
    const state=(await host('/api/state',undefined,admin,'GET',header)).value;
    assert.equal(state.rooms.length,2);assert.equal(state.devices.length,0);assert.equal(state.transfers.length,0);
    const settings=(await host('/api/settings',undefined,admin,'GET',header)).value;assert.equal(settings.hasKey,false);
    const invite=(await host('/api/invitation',undefined,admin,'GET',header)).value;
    const member=(await mobile('/device/join',{roomId:invite.roomId,password:invite.password,name:'multiroom',version:'12',physicalId:'same-phone'})).value;
    const link=await connect(member,{files:true,control:true,screenAllowed:true,agent:true});
    await until(async()=> (await host('/api/state',undefined,admin,'GET',header)).value.devices.some(d=>d.id===member.deviceId&&d.online));
    assert.equal((await mobile('/device/agent/runs',{task:'cross-room peer',targetDeviceId:device.deviceId},member.token)).status,403);
    link.ws.send(JSON.stringify({type:'heartbeat',activity:'busy',ownerRoom:'Other PC',permissions:{files:true,control:true,screenAllowed:true,agent:true}}));
    await until(async()=>(await host('/api/state',undefined,admin,'GET',header)).value.devices[0].activity==='busy');
    assert.equal((await host(`/api/devices/${member.deviceId}/command`,{tool:'home',arguments:{}})).status,403);
    assert.equal((await host(`/api/devices/${member.deviceId}/mirror`,{maxSize:1280,fps:30,bitrate:6},admin,'POST',header)).status,409);
    assert.equal((await host(`/api/devices/${member.deviceId}/command`,{tool:'home',arguments:{}},admin,'POST',header)).status,409);
    const roomFile=await mobile('/device/files',rawFile,member.token,'POST',{'X-File-Name':'busy-file.txt'});
    assert.equal(roomFile.status,200);
    assert.equal((await mobile('/device/agent/runs',{task:'home'},member.token)).status,409);
    assert.equal((await host(`/api/files/${fileId}/send`,{deviceId:member.deviceId})).status,403);
    const dissolved=await host(`/api/rooms/${room.id}`,undefined,admin,'DELETE');
    assert.equal(dissolved.status,200);
    assert.ok(dissolved.value.fileArchive.startsWith('removed-rooms'));
    const archive=resolve(data,dissolved.value.fileArchive);
    assert.ok((await readdir(archive)).some(name=>name.endsWith('.blob')));
    assert.ok((await stat(resolve(archive,'files.dat'))).size>0);
    assert.ok(!(await readdir(resolve(data,'files'))).includes(roomFile.value.id+'.blob'));
    assert.equal((await mobile('/device/room',undefined,member.token)).status,401);
    assert.equal((await host('/api/rooms')).value.length,1);
  });
  await check('room dissolution restores room and library copies when final persistence fails, then permits retry', async()=>{
    const room=(await host('/api/rooms',{name:'归档事务失败回归'})).value;
    const header={'X-Nexus-Room':room.id};
    const beforeRooms=(await host('/api/rooms')).value.map(item=>item.id);
    const bytes=Buffer.from('recoverable room file after state persistence failure');
    const upload=await fetch(base+'/api/files',{method:'POST',headers:{Authorization:`Bearer ${admin}`,'X-Nexus-Request':'1','X-Nexus-Room':room.id,'X-File-Name':'rollback.txt'},body:bytes});
    assert.equal(upload.status,200);const transfer=await upload.json();
    // An empty directory at the temporary state file path deterministically
    // fails final Save without changing archive metadata or existing state.dat.
    const blockedState=resolve(data,'state.dat.tmp');await mkdir(blockedState);
    try {
      assert.equal((await host(`/api/rooms/${room.id}`,undefined,admin,'DELETE')).status,500);
      assert.deepEqual((await host('/api/rooms')).value.map(item=>item.id),beforeRooms);
      const restored=(await host('/api/state',undefined,admin,'GET',header)).value;
      assert.ok(restored.transfers.some(item=>item.id===transfer.id));
      assert.deepEqual(await readFile(resolve(data,'files',transfer.id+'.blob')),bytes);
      assert.ok((await readdir(resolve(data,'removed-rooms'))).some(name=>name.startsWith(room.id+'-')));
    } finally {await rmdir(blockedState);}
    const dissolved=await host(`/api/rooms/${room.id}`,undefined,admin,'DELETE');assert.equal(dissolved.status,200);
    assert.deepEqual(await readFile(resolve(data,dissolved.value.fileArchive,transfer.id+'.blob')),bytes);
    assert.equal((await host('/api/rooms')).value.some(item=>item.id===room.id),false);
    const empty=(await host('/api/rooms',{name:'无文件房间提交回归'})).value;
    const emptyDissolved=await host(`/api/rooms/${empty.id}`,undefined,admin,'DELETE');assert.equal(emptyDissolved.status,200);
    assert.equal(emptyDissolved.value.fileArchive,'');assert.equal((await host('/api/rooms')).value.some(item=>item.id===empty.id),false);
  });
  await check('kicked member may rejoin with a fresh token and leave cleanly', async()=>{
    const invite=(await host('/api/invitation')).value;
    const member=(await mobile('/device/join',{roomId:invite.roomId,password:invite.password,name:'rejoined',version:'12'})).value;
    assert.ok(member.token && member.token!==device.token);
    const result=await mobile('/device/leave',{},member.token);assert.equal(result.status,200);
    assert.equal((await mobile('/device/room',undefined,member.token)).status,401);
    assert.ok(!(await host('/api/state')).value.devices.some(d=>d.id===member.deviceId));
  });
  console.log(`\n${count} integration checks passed. Isolated state: ${data}`);
} catch (error) { console.error(error); console.error(logs.slice(-4000)); process.exitCode = 1; }
finally { for (const ws of sockets) ws.terminate(); child.kill(); await Promise.race([once(child, 'exit'), wait(3000)]); }
