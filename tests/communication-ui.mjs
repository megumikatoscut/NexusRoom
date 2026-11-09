import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import https from 'node:https';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { chromium } from 'playwright';

// Actual Host, authenticated TLS/WSS, production Web UI and real WebRTC RTP.
// The two phone peers use browser media fixtures, not native Android hardware.
const root = resolve(import.meta.dirname, '..');
const release = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'));
const data = resolve(root, '.local', `communication-ui-${Date.now()}`);
const evidence = process.env.NEXUS_COMMUNICATION_EVIDENCE || join(data, 'evidence');
await mkdir(data, { recursive: true }); await mkdir(evidence, { recursive: true });
const uiPort = Number(process.env.NEXUS_COMMUNICATION_UI_PORT || 19590), devicePort = Number(process.env.NEXUS_COMMUNICATION_DEVICE_PORT || 19591);
const origin = `http://127.0.0.1:${uiPort}`, deviceOrigin = `https://127.0.0.1:${devicePort}`, debugOrigin = `http://127.0.0.1:${uiPort + 4}`;
const executable = process.env.NEXUS_TEST_HOST;
const desktopShell = process.env.NEXUS_QA_WEBVIEW === '1', nativeScreen = process.env.NEXUS_QA_NATIVE_SCREEN === '1', nativeAudio = process.env.NEXUS_QA_NATIVE_SCREEN_AUDIO === '1';
assert.ok(!desktopShell || executable, 'Visible WebView QA requires an explicit compiled EXE');
const host = spawn(executable || 'dotnet', executable ? (desktopShell ? [] : ['--headless']) : [join(root, 'src/NexusRoom.Host/bin/Debug/net10.0-windows/NexusRoom.Host.dll'), '--headless'], {
  cwd: root, windowsHide: !desktopShell, env: { ...process.env, NEXUS_DATA_DIR: data, NEXUS_UI_PORT: String(uiPort), NEXUS_DEVICE_PORT: String(devicePort), NEXUS_DISCOVERY_PORT: String(uiPort + 2), NEXUS_DISABLE_MDNS: '1',
    ...(desktopShell ? { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${uiPort + 4} --use-fake-device-for-media-stream --auto-select-desktop-capture-source=Entire screen --lang=en-US` } : {}) }, stdio: ['ignore', 'pipe', 'pipe'],
});
let hostLog = '', token, fingerprint, room, browser, desktopBrowser, permissionHelper, productionPage;
const fixtures = [];
host.stdout.on('data', value => { hostLog = (hostLog + value).slice(-20000); }); host.stderr.on('data', value => { hostLog = (hostLog + value).slice(-20000); });
const sockets = [], peerControls = [], results = [];
const pause = ms => new Promise(accept => setTimeout(accept, ms));
async function until(predicate, message, timeout = 15000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await predicate()) return; await pause(100); } throw new Error(message); }
async function check(name, action) { await action(); results.push({ name, passed: true }); console.log('PASS ' + name); }
async function admin(path, body, roomId = room, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(origin + path, { method, headers: { Authorization: `Bearer ${token}`, 'X-Nexus-Request': '1', 'X-Nexus-Room': roomId ?? '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json(); assert.ok(response.ok, `Local API ${response.status}: ${value.title}`); return value;
}
async function mobile(device, path, body) {
  return new Promise((accept, reject) => {
    const request = https.request(deviceOrigin + path, { method: body === undefined ? 'GET' : 'POST', rejectUnauthorized: false, agent: false, headers: { Authorization: 'Bearer ' + (device?.token ?? ''), 'Content-Type': 'application/json' } }, response => {
      const certificate = response.socket.getPeerCertificate();
      if (createHash('sha256').update(certificate.raw).digest('hex') !== fingerprint) { response.destroy(); reject(new Error('TLS certificate pin mismatch')); return; }
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject); response.on('end', () => { const value = JSON.parse(Buffer.concat(chunks).toString()); accept({ status: response.statusCode, value }); });
    }); request.on('error', reject); if (body !== undefined) request.write(JSON.stringify(body)); request.end();
  });
}
async function mobileOk(device, path, body) { const result = await mobile(device, path, body); assert.equal(result.status, 200, 'Device action: ' + JSON.stringify(result.value)); return result.value; }
async function deviceSocket(device, path) {
  const socket = new WebSocket(deviceOrigin.replace('https:', 'wss:') + path, { rejectUnauthorized: false, headers: { Authorization: 'Bearer ' + device.token } }); sockets.push(socket);
  await new Promise((accept, reject) => { socket.once('error', reject); socket.once('open', () => { assert.equal(createHash('sha256').update(socket._socket.getPeerCertificate().raw).digest('hex'), fingerprint); accept(); }); });
  return socket;
}

async function phone(name, invitation) {
  const joined = await mobileOk(null, '/device/join', { roomId: invitation.roomId, password: invitation.password, name, model: name, version: '14', physicalId: 'qa-' + name });
  const device = { ...joined, id: joined.deviceId };
  const link = await deviceSocket(device, '/device/ws');
  link.send(JSON.stringify({ type: 'hello', width: 720, height: 1280, battery: 90, model: name, permissions: {} }));
  const timer = setInterval(() => { if (link.readyState === WebSocket.OPEN) link.send(JSON.stringify({ type: 'heartbeat', battery: 90, permissions: {} })); }, 5000);
  peerControls.push(() => clearInterval(timer));
  await until(async () => (await admin('/api/state')).devices.some(d => d.id === device.id && d.online), 'Phone membership did not become online');
  const page = await browser.newPage();
  await page.route('**/__qa_media_peer', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>NexusRoom RTP fixture</title><p>Controlled WebRTC peer</p>' }));
  await page.goto(origin + '/__qa_media_peer');
  const comm = await deviceSocket(device, '/device/communication/ws');
  await page.exposeFunction('qaSend', (sessionId, targetId, signal) => { if (comm.readyState === WebSocket.OPEN) comm.send(JSON.stringify({ type: 'signal', sessionId, targetId, signal })); });
  await page.evaluate(selfId => {
    const peers = new Map(); let session, stream, generation = 0; const timers = [];
    const errors = []; window.qaErrors = errors; window.qaPeers = peers;
    const clear = () => { generation++; for (const value of peers.values()) value.pc.close(); peers.clear(); stream?.getTracks().forEach(t => t.stop()); stream = undefined; timers.splice(0).forEach(clearInterval); };
    const enqueue = (peer, action) => { peer.queue = peer.queue.then(async () => { if (peer.pc.signalingState !== 'closed') await action(); }).catch(e => errors.push(e.message)); };
    const create = id => {
      const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
      const value = { pc, queue: Promise.resolve(), candidates: [] }; peers.set(id, value);
      if (selfId < id) {
        pc.addTransceiver(stream.getAudioTracks()[0], { direction: 'sendrecv', streams: [stream] });
        pc.addTransceiver(session.kind === 'meeting' ? stream.getVideoTracks()[0] : 'video', { direction: session.kind === 'meeting' ? 'sendrecv' : 'inactive', streams: [stream] });
        pc.addTransceiver('video', { direction: session.kind === 'meeting' ? 'sendrecv' : 'inactive' });
        pc.addTransceiver('audio', { direction: session.kind === 'meeting' ? 'sendrecv' : 'inactive' });
        if (session.kind === 'meeting') value.channel = pc.createDataChannel('nr-screen-audio', { ordered: false, maxRetransmits: 0 });
      }
      pc.ondatachannel = event => { value.channel = event.channel; };
      pc.onicecandidate = event => { if (event.candidate && session) void window.qaSend(session.id, id, { type: 'ice', candidate: event.candidate.toJSON() }); };
      if (selfId < id) enqueue(value, async () => { await pc.setLocalDescription(await pc.createOffer()); await window.qaSend(session.id, id, { type: 'offer', sdp: pc.localDescription.sdp }); });
      return value;
    };
    window.qaCameraShape = async (width, height) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const ctx = canvas.getContext('2d');
      const draw = () => { ctx.fillStyle = '#164832'; ctx.fillRect(0, 0, width, height); ctx.lineWidth = 24; ctx.strokeStyle = '#ffcf40'; ctx.strokeRect(12, 12, width - 24, height - 24); ctx.fillStyle = '#fff'; ctx.font = '24px sans-serif'; ctx.fillText('Camera full frame ' + width + 'x' + height, 28, 70); ctx.fillText(String(performance.now()), 28, 110); };
      draw(); timers.push(setInterval(draw, 80)); const track = canvas.captureStream(12).getVideoTracks()[0];
      for (const old of stream.getVideoTracks()) { stream.removeTrack(old); old.stop(); } stream.addTrack(track);
      await Promise.all([...peers.values()].map(value => value.pc.getTransceivers()[1].sender.replaceTrack(track)));
    };
    window.qaScreenPcm = () => {
      let frame = 0; const timer = setInterval(() => { const pcm = new ArrayBuffer(1928), view = new DataView(pcm); view.setUint32(0, 0x4e524131); view.setUint32(4, 48000);
        for (let i = 0; i < 960; i++) view.setInt16(8 + i * 2, Math.round(Math.sin((frame++ * 997 * 2 * Math.PI) / 48000) * 10000), true);
        for (const value of peers.values()) if (value.channel?.readyState === 'open') value.channel.send(pcm);
      }, 20); timers.push(timer);
    };
    window.qaState = async state => {
      const next = state.sessions.find(s => s.status === 'active' && s.participants.some(p => p.deviceId === selfId));
      if (next?.id !== session?.id) { clear(); session = next; if (next) { const gen = generation; const captured = await navigator.mediaDevices.getUserMedia({ audio: true, video: next.kind === 'meeting' }); if (gen !== generation) { captured.getTracks().forEach(t => t.stop()); return; } stream = captured; } }
      session = next;
      if (!next || !stream) return;
      const ids = new Set(next.participants.map(p => p.deviceId).filter(id => id !== selfId));
      for (const [id, peer] of peers) if (!ids.has(id)) { peer.pc.close(); peers.delete(id); }
      for (const id of ids) if (!peers.has(id)) create(id);
    };
    window.qaSignal = message => {
      if (!session || message.sessionId !== session.id) return;
      const peer = peers.get(message.fromId) ?? create(message.fromId), signal = message.signal;
      enqueue(peer, async () => {
        if (signal.type === 'ice') { if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(signal.candidate); else peer.candidates.push(signal.candidate); return; }
        await peer.pc.setRemoteDescription({ type: signal.type, sdp: signal.sdp });
        for (const item of peer.candidates.splice(0)) await peer.pc.addIceCandidate(item);
        if (signal.type === 'offer') {
          await Promise.all(peer.pc.getTransceivers().map(async (t, i) => { t.direction = session.kind === 'call' && i > 0 ? 'inactive' : 'sendrecv'; t.sender.setStreams(stream); await t.sender.replaceTrack(i === 0 ? stream.getAudioTracks()[0] : i === 1 && session.kind === 'meeting' ? stream.getVideoTracks()[0] : null); }));
          await peer.pc.setLocalDescription(await peer.pc.createAnswer()); await window.qaSend(session.id, message.fromId, { type: 'answer', sdp: peer.pc.localDescription.sdp });
        }
      });
    };
  }, device.id);
  let queue = Promise.resolve();
  comm.on('message', raw => {
    const message = JSON.parse(raw.toString());
    queue = queue.then(async () => { if (message.type === 'state') { device.state = message.state; await page.evaluate(value => window.qaState(value), message.state); } else if (message.type === 'signal') await page.evaluate(value => window.qaSignal(value), message); }).catch(error => { device.error = error.message; });
  });
  const ping = setInterval(() => { if (comm.readyState === WebSocket.OPEN) comm.send(JSON.stringify({ type: 'ping' })); }, 15000);
  peerControls.push(() => clearInterval(ping));
  // Initial WS state may arrive before the listener has been installed.
  device.state = await mobileOk(device, '/device/communication/state'); await page.evaluate(value => window.qaState(value), device.state);
  const fixture = { device, page, comm }; fixtures.push(fixture); return fixture;
}

try {
  await until(async () => { assert.equal(host.exitCode, null, 'QA Host stopped'); return fetch(origin + '/health').then(r => r.ok).catch(() => false); }, 'Host did not start');
  await until(async () => { assert.equal(host.exitCode, null, 'QA Host stopped before its launch file was written'); return access(join(data, 'launch.dat')).then(() => true).catch(() => false); }, 'Host did not write its isolated launch file');
  const launchPath = join(data, 'launch.dat').replaceAll("'", "''");
  const launch = JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes('${launchPath}'),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))`], { encoding: 'utf8', windowsHide: true }).trim());
  token = new URL(launch).hash.slice('#bootstrap='.length);
  room = (await admin('/api/state')).room.id;
  const invitation = await admin('/api/invitation'); fingerprint = invitation.fingerprint;
  browser = await chromium.launch({ ...(process.env.NEXUS_QA_BROWSER ? { executablePath: process.env.NEXUS_QA_BROWSER } : { channel: 'chrome' }), headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const a = await phone('QA Android A', invitation), b = await phone('QA Android B', invitation);
  if (desktopShell) {
    permissionHelper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(root, 'tests/fixtures/ApproveCommunicationMedia.ps1'), '-HostProcessId', String(host.pid)], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    permissionHelper.stderr.on('data', value => { void appendFile(join(data, 'permission-helper-error.log'), value); });
    await until(async () => fetch(debugOrigin + '/json/version').then(r => r.ok).catch(() => false), 'Visible WebView did not expose its QA debugging port');
    desktopBrowser = await chromium.connectOverCDP(debugOrigin);
    await until(() => desktopBrowser.contexts().some(c => c.pages().length), 'Visible WebView did not create its control-centre page');
  }
  const page = desktopShell ? desktopBrowser.contexts().flatMap(c => c.pages())[0] : await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], consoleMessages = [];
  await page.setViewportSize({ width: 1440, height: 1000 });
  productionPage = page;
  // Native-camera QA measures RTP, but screenshots must not retain real pixels.
  if (desktopShell) {
    const screenshot = page.screenshot.bind(page);
    page.screenshot = options => screenshot({ ...options, mask: [page.locator('.participant-camera')] });
  }
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type()) && consoleMessages.length < 50) consoleMessages.push({ level: message.type(), message: message.text().slice(0, 1000) }); });
  await page.addInitScript(() => {
    const Original = window.RTCPeerConnection; window.qaConnections = [];
    window.RTCPeerConnection = class extends Original { constructor(...args) { super(...args); window.qaConnections.push(this); } };
    const OriginalAudio = window.AudioContext; window.qaAudioContexts = [];
    window.AudioContext = class extends OriginalAudio { constructor(...args) { super(...args); this.qaStarts = []; window.qaAudioContexts.push(this); }
      createMediaStreamDestination() { const destination = super.createMediaStreamDestination(); this.qaDestination = destination.stream; return destination; }
      createBufferSource() { const source = super.createBufferSource(), start = source.start.bind(source); source.start = (...args) => { this.qaStarts.push({ time: args[0], samples: source.buffer?.length, current: this.currentTime }); if (this.qaStarts.length > 16) this.qaStarts.shift(); return start(...args); }; return source; }
    };
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); window.qaMediaRequests = 0; window.qaLocalTracks = [];
    navigator.mediaDevices.getUserMedia = async constraints => { window.qaMediaRequests++; const stream = await capture(constraints); window.qaLocalTracks.push(...stream.getTracks()); return stream; };
    const canvasCapture = HTMLCanvasElement.prototype.captureStream;
    HTMLCanvasElement.prototype.captureStream = function(...args) { const stream = canvasCapture.apply(this, args); window.qaLocalTracks.push(...stream.getTracks()); return stream; };
  });
  await page.goto(launch); if (desktopShell) await page.reload();
  await page.getByRole('heading', { name: '房间总览', exact: true }).waitFor();
  await page.getByRole('button', { name: '通话与会议', exact: true }).click();
  const pcId = `pc:${room}`;
  await until(async () => (await admin('/api/communication/state')).devices.some(d => d.id === pcId && d.communicationOnline), 'Production PC communication channel did not connect');
  await check('production page identity, meaningful content and connected device roster', async () => {
    assert.match(await page.title(), /NexusRoom/); await page.getByRole('heading', { name: '通话与会议', exact: true }).waitFor(); assert.equal(await page.locator('.communication-devices .btn').count(), 2); assert.equal(await page.getByText('正在连接房间通信服务…', { exact: true }).count(), 0);
  });
  await check('PC to Android request requires acceptance then exchanges actual bidirectional audio RTP', async () => {
    await page.locator('.communication-devices>div').filter({ hasText: 'QA Android A' }).getByRole('button', { name: '呼叫' }).click();
    await until(async () => a.device.state?.sessions.some(s => s.status === 'ringing'), 'Callee did not receive the call');
    const call = a.device.state.sessions.find(s => s.status === 'ringing');
    assert.equal(call.callerId, pcId); assert.equal(call.calleeId, a.device.id);
    assert.equal((await mobile(a.device, `/device/communication/sessions/${call.id}/media`, { microphone: true, camera: false, screen: false })).status, 409);
    await mobileOk(a.device, `/device/communication/calls/${call.id}/decision`, { accept: true });
    await mobileOk(a.device, `/device/communication/sessions/${call.id}/media`, { microphone: true, camera: false, screen: false });
    await page.getByText('2 / 8 位成员', { exact: true }).waitFor();
    await until(async () => page.evaluate(async () => { const pcs = window.qaConnections.filter(pc => pc.connectionState === 'connected'); if (!pcs.length) return false; const stats = [...(await pcs[0].getStats()).values()]; return stats.some(s => s.type === 'inbound-rtp' && s.kind === 'audio' && s.bytesReceived > 1000) && stats.some(s => s.type === 'outbound-rtp' && s.kind === 'audio' && s.bytesSent > 1000); }), 'Bidirectional RTP audio did not arrive', 25000);
    await page.screenshot({ path: join(evidence, 'private-audio-call.png') });
    await page.waitForFunction(() => { const audio = document.querySelector('.communication-playback video'); if (!audio || audio.paused || audio.readyState < 2) return false; window.qaActiveAudio = audio; window.qaAudioTime = audio.currentTime; return true; });
    await page.getByRole('button', { name: '房间总览', exact: true }).click(); await page.getByRole('heading', { name: '房间总览', exact: true }).waitFor();
    await page.waitForFunction(() => { const audio = document.querySelector('.communication-playback video'); return audio === window.qaActiveAudio && !audio.paused && !audio.muted && audio.currentTime > window.qaAudioTime; });
    await page.getByRole('button', { name: '通话与会议', exact: true }).click(); await page.getByRole('button', { name: '挂断', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.querySelector('.communication-playback video') === window.qaActiveAudio), true);
    await page.getByRole('button', { name: '关闭扬声器', exact: true }).click(); assert.equal(await page.evaluate(() => window.qaActiveAudio.muted), true);
    await page.getByRole('button', { name: '开启扬声器', exact: true }).click(); assert.equal(await page.evaluate(() => window.qaActiveAudio.muted), false);
    await page.getByRole('button', { name: '挂断', exact: true }).click();
    await until(async () => page.evaluate(() => window.qaConnections.every(pc => pc.connectionState === 'closed' && pc.getSenders().every(s => !s.track || s.track.readyState === 'ended'))), 'Hangup did not stop every sender and connection');
  });
  await check('public three-participant meeting, camera RTP and chat use authenticated production paths', async () => {
    await page.getByRole('button', { name: '创建会议', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '创建视频会议', exact: true });
    await dialog.getByRole('textbox', { name: '会议名称' }).fill('公开联调会议'); await dialog.getByRole('button', { name: '创建会议', exact: true }).click();
    await page.getByRole('heading', { name: '公开联调会议', exact: true }).waitFor();
    const meeting = (await admin('/api/communication/state')).sessions.find(s => s.status === 'active');
    await mobileOk(a.device, `/device/communication/meetings/${meeting.id}/join`, {}); await mobileOk(b.device, `/device/communication/meetings/${meeting.id}/join`, {});
    for (const participant of [a, b]) await mobileOk(participant.device, `/device/communication/sessions/${meeting.id}/media`, { microphone: true, camera: true, screen: false });
    await page.getByText('3 / 8 位成员', { exact: true }).waitFor();
    await page.getByRole('button', { name: '开启麦克风', exact: true }).click(); await page.getByRole('button', { name: '开启摄像头', exact: true }).click();
    await until(async () => page.evaluate(async () => { const pcs = window.qaConnections.filter(pc => pc.connectionState === 'connected'); if (pcs.length !== 2) return false; return (await Promise.all(pcs.map(async pc => { const stats = [...(await pc.getStats()).values()]; return stats.some(s => s.type === 'inbound-rtp' && s.kind === 'video' && s.framesDecoded > 3) && stats.some(s => s.type === 'outbound-rtp' && s.kind === 'video' && s.framesEncoded > 3); }))).every(Boolean); }), 'Camera RTP did not pass in both directions', 25000);
    await a.page.evaluate(() => window.qaCameraShape(360, 640));
    const portraitTile = page.locator('.participant-tile').filter({ hasText: 'QA Android A' });
    await until(() => portraitTile.locator('.participant-camera video').evaluate(video => video.videoWidth === 360 && video.videoHeight === 640), 'Portrait camera frames did not arrive');
    assert.equal(await portraitTile.locator('.participant-camera video').evaluate(video => { const box = video.getBoundingClientRect(), stage = video.parentElement.getBoundingClientRect(); return getComputedStyle(video).objectFit === 'contain' && Math.abs(box.height - stage.height) < 1 && Math.abs(box.width - stage.width) < 1; }), true, 'Intrinsic camera size must not overflow and crop the stage');
    results.push({ name: 'portrait camera full frame remains contained inside its desktop video stage', passed: true });
    await page.getByRole('textbox', { name: '会议聊天内容', exact: true }).fill('Windows：你好，会议成员。'); await page.getByRole('button', { name: '发送', exact: true }).click();
    await mobileOk(a.device, `/device/communication/sessions/${meeting.id}/chat`, { text: 'Android：收到。😀' }); await page.getByRole('log', { name: '会议消息' }).getByText('Android：收到。😀', { exact: true }).waitFor();
    await until(async () => (await mobileOk(b.device, '/device/communication/state')).sessions.find(s => s.id === meeting.id)?.messages.length === 2, 'All participants did not receive chat');
    await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: join(evidence, 'public-meeting.png') });
    await page.setViewportSize({ width: 430, height: 900 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Meeting overflows narrow viewport'); await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: join(evidence, 'meeting-narrow.png') }); await page.setViewportSize({ width: 1440, height: 1000 });
    // Controlled display source verifies the independent screen slot and RTP.
    // Native system capture consent is exercised separately on the APK.
    if (!nativeScreen) await page.evaluate(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 540; const ctx = canvas.getContext('2d');
        const draw = () => { ctx.fillStyle = '#1c4538'; ctx.fillRect(0, 0, 960, 540); ctx.fillStyle = '#ecfff4'; ctx.font = '36px sans-serif'; ctx.fillText('NexusRoom screen-share RTP fixture', 42, 90); ctx.fillText(String(performance.now()), 42, 160); };
        draw(); const timer = setInterval(draw, 80), stream = canvas.captureStream(12); stream.getTracks()[0].addEventListener('ended', () => clearInterval(timer)); return stream;
      };
    });
    await page.getByRole('button', { name: '共享屏幕', exact: true }).click(); await page.getByRole('button', { name: '停止共享屏幕', exact: true }).waitFor();
    for (const participant of [a, b]) await until(async () => participant.page.evaluate(async () => { for (const value of window.qaPeers.values()) { const stats = [...(await value.pc.getStats()).values()]; if (stats.some(s => s.type === 'inbound-rtp' && s.kind === 'video' && s.mid === '2' && s.framesDecoded > 3)) return true; } return false; }), 'Independent screen RTP did not arrive', 20000);
    const shared = page.locator('.shared-screen');
    await shared.getByRole('button', { name: /^全屏查看 / }).click();
    await until(() => shared.evaluate(stage => document.fullscreenElement === stage || stage.classList.contains('screen-expanded')), 'Shared screen did not enter fullscreen');
    assert.equal(await shared.evaluate(stage => { const box = stage.getBoundingClientRect(); return box.width >= innerWidth - 2 && box.height >= innerHeight - 2; }), true, 'Fullscreen must use the viewport');
    await page.screenshot({ path: join(evidence, 'communication-screen-fullscreen.png') });
    await shared.getByRole('button', { name: /^退出 .* 屏幕全屏$/ }).click();
    await until(() => shared.evaluate(stage => document.fullscreenElement !== stage && !stage.classList.contains('screen-expanded')), 'Shared screen did not exit fullscreen');
    results.push({ name: 'shared screen enters viewport fullscreen and its exit button stays accessible above the Agent', passed: true });
    await page.getByRole('button', { name: '静音', exact: true }).click();
    if (!nativeAudio) {
      await page.route('**/api/communication/screen-audio/capability', route => route.fulfill({ json: { supported: true, sampleRate: 48000, channels: 1, encoding: 'pcm16le' } }));
      await page.evaluate(() => {
        const Original = window.WebSocket; window.qaPcmBridges = [];
        class ControlledPcm {
          readyState = 0; constructor() {
            window.qaPcmBridges.push(this); let frame = 0;
            this.opening = setTimeout(() => { this.readyState = 1; this.onmessage?.({ data: JSON.stringify({ type: 'ready' }) });
              this.timer = setInterval(() => { const pcm = new ArrayBuffer(1920), view = new DataView(pcm); for (let i = 0; i < 960; i++) view.setInt16(i * 2, Math.round(Math.sin((frame++ * 997 * 2 * Math.PI) / 48000) * 8000), true); this.onmessage?.({ data: pcm }); }, 20);
            }, 0);
          }
          close() { this.readyState = 3; clearTimeout(this.opening); clearInterval(this.timer); this.onclose?.({ reason: '' }); }
        }
        window.WebSocket = class extends Original { constructor(url, protocols) { if (String(url).includes('/screen-audio/ws?')) return new ControlledPcm(); super(url, protocols); } };
      });
    }
    await page.getByRole('checkbox', { name: /共享设备声音/ }).check();
    await page.getByText('已共享', { exact: true }).waitFor();
    for (const participant of [a, b]) await until(async () => participant.page.evaluate(async () => { for (const value of window.qaPeers.values()) { const stats = [...(await value.pc.getStats()).values()]; if (stats.some(s => s.type === 'inbound-rtp' && s.kind === 'audio' && s.mid === '3' && s.bytesReceived > 1000)) return true; } return false; }), 'Independent device audio MID3 RTP did not arrive', 20000);
    assert.equal(await page.evaluate(() => window.qaConnections.filter(pc => pc.connectionState === 'connected').every(pc => pc.getTransceivers()[0].sender.track === null && pc.getTransceivers()[3].sender.track?.readyState === 'live')), true, 'Device sound must work while the microphone remains muted');
    await page.getByRole('checkbox', { name: /共享设备声音/ }).uncheck();
    await until(() => page.evaluate(() => window.qaConnections.filter(pc => pc.connectionState === 'connected').every(pc => pc.getTransceivers()[3].sender.track === null)), 'Device sound sender did not stop');
    if (!nativeAudio) assert.equal(await page.evaluate(() => window.qaPcmBridges.length === 1 && window.qaPcmBridges.every(socket => socket.readyState === 3)), true, 'Controlled PCM capture must close when disabled');
    assert.equal((await admin('/api/communication/state')).sessions.find(s => s.id === meeting.id).participants.find(p => p.deviceId === pcId).screenAudio, false);
    results.push({ name: 'optional device audio MID3 reaches both peers with microphone muted and releases on disable', source: nativeAudio ? 'Windows isolated process loopback' : 'controlled PCM bridge', passed: true });
    await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: join(evidence, 'communication-screen-sharing.png') }); await page.getByRole('button', { name: '停止共享屏幕', exact: true }).click();
    await page.getByRole('button', { name: '共享屏幕', exact: true }).waitFor();
    await mobileOk(a.device, `/device/communication/sessions/${meeting.id}/media`, { microphone: true, camera: true, screen: true, screenAudio: true });
    await a.page.evaluate(() => window.qaScreenPcm());
    await until(() => page.locator('video[aria-label="QA Android A 共享设备声音"]').evaluate(video => !!video.srcObject && video.srcObject.getAudioTracks().length === 1 && video.readyState >= 2 && window.qaAudioContexts.some(context => context.state === 'running' && context.qaDestination === video.srcObject && context.qaStarts.length > 0)), 'Controlled Android device PCM did not produce its own playback stream');
    const pcmMeasure = await page.locator('video[aria-label="QA Android A 共享设备声音"]').evaluate(async video => {
      const context = new AudioContext(); await context.resume(); const source = context.createMediaStreamSource(video.srcObject), analyser = context.createAnalyser(); analyser.fftSize = 1024; source.connect(analyser);
      let rms = 0; const samples = new Float32Array(1024); for (let i = 0; i < 20 && rms < .02; i++) { await new Promise(resolve => setTimeout(resolve, 100)); analyser.getFloatTimeDomainData(samples); rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length); }
      source.disconnect(); await context.close(); return { rms, contexts: window.qaAudioContexts.map(value => ({ state: value.state, time: value.currentTime, starts: value.qaStarts })) };
    });
    const pcmRms = pcmMeasure.rms;
    assert.ok(pcmRms > .02, 'Android device audio datachannel must deliver audible PCM samples: ' + JSON.stringify(pcmMeasure));
    await page.getByRole('button', { name: '关闭扬声器', exact: true }).click(); assert.equal(await page.locator('video[aria-label="QA Android A 共享设备声音"]').evaluate(video => video.muted), true);
    await page.getByRole('button', { name: '开启扬声器', exact: true }).click();
    await mobileOk(a.device, `/device/communication/sessions/${meeting.id}/media`, { microphone: true, camera: true, screen: false, screenAudio: false });
    await until(() => page.locator('video[aria-label="QA Android A 共享设备声音"]').evaluate(video => video.muted), 'Stopped Android device sound remained audible');
    results.push({ name: 'controlled Android playback PCM arrives over datachannel with a single authorized muted playback stream', source: 'controlled datachannel PCM; native Android capture validated separately', pcmRms, passed: true });
    await mobileOk(a.device, `/device/communication/sessions/${meeting.id}/leave`, {}); await page.getByText('2 / 8 位成员', { exact: true }).waitFor();
    await page.getByRole('button', { name: '结束会议', exact: true }).click(); await until(async () => !(await mobileOk(b.device, '/device/communication/state')).activeSessionId, 'Host end did not remove other participant');
  });
  await check('private meeting is hidden, invites require explicit acceptance and expelled members cannot rejoin', async () => {
    await page.getByRole('button', { name: '创建会议', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '创建视频会议', exact: true });
    await dialog.getByRole('textbox', { name: '会议名称' }).fill('私密联调会议'); await dialog.getByRole('combobox', { name: '会议权限' }).selectOption('private'); await dialog.getByRole('checkbox', { name: /QA Android A/ }).check(); await dialog.getByRole('button', { name: '创建会议', exact: true }).click();
    await page.getByRole('heading', { name: '私密联调会议', exact: true }).waitFor(); const meeting = (await admin('/api/communication/state')).sessions.find(s => s.status === 'active');
    const outsider = await mobileOk(b.device, '/device/communication/state'); assert.equal(outsider.sessions.some(s => s.id === meeting.id), false); assert.equal(outsider.invitations.length, 0);
    assert.equal((await mobile(b.device, `/device/communication/meetings/${meeting.id}/join`, {})).status, 404);
    const invited = await mobileOk(a.device, '/device/communication/state'); assert.equal(invited.sessions.some(s => s.id === meeting.id), false); const invitation = invited.invitations.find(i => i.sessionId === meeting.id); assert.ok(invitation);
    await mobileOk(a.device, `/device/communication/invitations/${invitation.id}/decision`, { accept: true }); await page.getByText('2 / 8 位成员', { exact: true }).waitFor();
    await page.getByRole('textbox', { name: '会议聊天内容' }).fill('私密会议内容'); await page.getByRole('button', { name: '发送', exact: true }).click();
    assert.equal(JSON.stringify(await mobileOk(b.device, '/device/communication/state')).includes('私密会议内容'), false);
    await page.getByRole('button', { name: '移出 QA Android A', exact: true }).click(); await page.getByText('1 / 8 位成员', { exact: true }).waitFor();
    assert.equal((await mobile(a.device, `/device/communication/meetings/${meeting.id}/join`, {})).status, 403);
    await page.screenshot({ path: join(evidence, 'private-meeting.png') }); await page.getByRole('button', { name: '结束会议', exact: true }).click();
  });
  await check('late outgoing call response cannot reopen a rejected call or request microphone access', async () => {
    let releaseResponse, responseHeld = false, responseDelivered = false;
    const routePattern = '**/api/communication/calls';
    await page.route(routePattern, async route => {
      const response = await route.fetch(); responseHeld = true;
      await new Promise(resolve => { releaseResponse = resolve; }); await route.fulfill({ response }); responseDelivered = true;
    });
    const before = await page.evaluate(() => window.qaMediaRequests);
    await page.locator('.communication-devices>div').filter({ hasText: 'QA Android A' }).getByRole('button', { name: '呼叫', exact: true }).click();
    await until(() => responseHeld, 'Call response was not intercepted');
    const call = (await mobileOk(a.device, '/device/communication/state')).sessions.find(s => s.status === 'ringing'); assert.ok(call);
    await mobileOk(a.device, `/device/communication/calls/${call.id}/decision`, { accept: false });
    await until(async () => (await admin('/api/communication/state')).activeSessionId === '', 'Rejected call stayed active');
    await page.locator('.communication-devices>div').filter({ hasText: 'QA Android A' }).getByRole('button', { name: '呼叫', exact: true }).waitFor({ state: 'visible' });
    releaseResponse(); await until(() => responseDelivered, 'Delayed response was not delivered'); await page.unroute(routePattern);
    await until(async () => page.locator('.communication-devices>div').filter({ hasText: 'QA Android A' }).getByRole('button', { name: '呼叫', exact: true }).isEnabled(), 'Delayed call action did not finish');
    assert.equal(await page.evaluate(() => window.qaMediaRequests), before);
    assert.equal(await page.getByRole('button', { name: '取消呼叫', exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => window.qaLocalTracks.filter(t => t.readyState === 'live').length), 0);
  });
  await check('late accepting response cannot reopen a call that the caller already ended', async () => {
    const call = (await mobileOk(a.device, '/device/communication/calls', { targetId: pcId })).session;
    const dialog = page.getByRole('dialog', { name: '收到私人电话', exact: true }); await dialog.waitFor();
    let releaseResponse, responseHeld = false, responseDelivered = false; const routePattern = `**/api/communication/calls/${call.id}/decision`;
    await page.route(routePattern, async route => {
      const response = await route.fetch(); responseHeld = true;
      await new Promise(resolve => { releaseResponse = resolve; }); await route.fulfill({ response }); responseDelivered = true;
    });
    const before = await page.evaluate(() => window.qaMediaRequests);
    await dialog.getByRole('button', { name: '接听', exact: true }).click(); await until(() => responseHeld, 'Accept response was not intercepted');
    await mobileOk(a.device, `/device/communication/sessions/${call.id}/end`, {});
    await page.locator('.communication-devices>div').filter({ hasText: 'QA Android A' }).getByRole('button', { name: '呼叫', exact: true }).waitFor({ state: 'visible' });
    releaseResponse(); await until(() => responseDelivered, 'Delayed response was not delivered'); await page.unroute(routePattern); await dialog.waitFor({ state: 'hidden' });
    // Let the deliberately held fetch handler and its promise continuation finish.
    await page.waitForFunction(() => window.qaConnections.every(pc => pc.signalingState === 'closed'));
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 150)));
    assert.equal(await page.evaluate(() => window.qaMediaRequests), before);
    assert.equal(await page.getByRole('button', { name: '挂断', exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => window.qaLocalTracks.filter(t => t.readyState === 'live').length), 0);
  });
  await check('incoming call remains reachable while PC displays another room, and rejection sends no media', async () => {
    const other = await admin('/api/rooms', { name: '切换房间 QA' }); await page.getByLabel('当前房间', { exact: true }).selectOption(other.id);
    await until(async () => (await admin('/api/communication/state', undefined, room)).devices.find(d => d.id === pcId)?.communicationOnline, 'Original room listener disconnected after switching');
    await mobileOk(a.device, '/device/communication/calls', { targetId: pcId });
    const dialog = page.getByRole('dialog', { name: '收到私人电话', exact: true }); await dialog.waitFor();
    const before = await page.evaluate(() => window.qaConnections.length); await dialog.getByRole('button', { name: '拒绝', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); assert.equal(await page.evaluate(() => window.qaConnections.length), before);
  });
  await check('Agent exposes arrange communication and no framework or runtime error appears', async () => {
    await page.getByRole('button', { name: '打开 Agent 悬浮窗', exact: true }).click(); await page.getByRole('button', { name: '安排会议或通话', exact: true }).click(); assert.match(await page.getByRole('textbox', { name: '输入 Agent 任务' }).inputValue(), /^给.+打电话$/);
    assert.deepEqual(errors, []); for (const peer of [a, b]) { assert.equal(peer.device.error, undefined); assert.deepEqual(await peer.page.evaluate(() => window.qaErrors), []); }
    assert.equal(await page.locator('vite-error-overlay').count(), 0);
    assert.deepEqual(consoleMessages.filter(message => message.level === 'error'), [], 'Production control centre logged console errors');
  });
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ version: release.version, browserPlugin: 'Browser plugin not available; repository Playwright used', target: executable ?? 'Debug Host', desktopShell, nativeScreen, nativeAudio,
    artifactSha256: executable ? { exe: createHash('sha256').update(await readFile(executable)).digest('hex'), dll: createHash('sha256').update(await readFile(join(resolve(executable, '..'), 'NexusRoom.Host.dll'))).digest('hex') } : undefined,
    source: 'Production UI / actual pinned TLS and bearer member authentication; controlled camera/microphone sources for browser peers', checks: results, pageErrors: errors, consoleMessages, viewports: ['1440x1000', '430x900'] }, null, 2));
  console.log(`${results.length} authenticated communication UI/RTP checks passed. Phone peers use controlled browser media; native APK acceptance is separate. Evidence: ${evidence}`);
} catch (error) {
  const describe = async page => page.evaluate(async () => {
    const connections = window.qaConnections ?? [...(window.qaPeers?.values() ?? [])].map(p => p.pc);
    return { errors: window.qaErrors, mediaRequests: window.qaMediaRequests, localTracks: window.qaLocalTracks?.map(t => ({ kind: t.kind, state: t.readyState })), body: document.body.innerText.slice(0, 1600), peers: await Promise.all(connections.map(async pc => ({ connection: pc.connectionState, ice: pc.iceConnectionState, signaling: pc.signalingState, localSdp: pc.localDescription?.sdp, remoteSdp: pc.remoteDescription?.sdp, tracks: pc.getTransceivers().map(t => ({ mid: t.mid, direction: t.direction, current: t.currentDirection, sender: t.sender.track?.readyState, receiver: t.receiver.track?.readyState })), stats: [...(await pc.getStats()).values()].filter(s => /rtp|candidate-pair/.test(s.type)).map(s => ({ type: s.type, kind: s.kind, bytesSent: s.bytesSent, bytesReceived: s.bytesReceived, framesDecoded: s.framesDecoded, state: s.state })) }))) };
  }).catch(e => ({ diagnosticError: e.message }));
  const diagnostics = productionPage ? [await describe(productionPage), ...await Promise.all(fixtures.map(f => describe(f.page)))] : [];
  if (productionPage) await productionPage.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ version: release.version, passed: results, failure: error.message, diagnostics }, null, 2)); throw error;
} finally {
  for (const stop of peerControls) stop(); for (const socket of sockets) socket.close(); await browser?.close(); await desktopBrowser?.close(); permissionHelper?.kill();
  if (host.exitCode === null) { host.kill(); await Promise.race([new Promise(accept => host.once('exit', accept)), pause(5000)]); }
}
