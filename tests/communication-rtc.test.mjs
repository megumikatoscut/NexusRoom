import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

// Exercise asynchronous resource ownership in the production RTC engine.
// Actual negotiation/RTP is covered separately by communication-ui.mjs.
const require = createRequire(new URL('../src/NexusRoom.Web/package.json', import.meta.url));
const ts = require('typescript');
const source = await readFile(new URL('../src/NexusRoom.Web/src/communication/rtc.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { RoomRtc } = await import('data:text/javascript;base64,' + Buffer.from(compiled + '\n//# sourceURL=RoomRtc.production.js').toString('base64'));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
class Track { constructor(kind = 'audio') { this.kind = kind; } readyState = 'live'; stop() { this.readyState = 'ended'; } }
class Stream {
  constructor(tracks = []) { this.tracks = [...tracks]; }
  getTracks() { return [...this.tracks]; }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
  addTrack(track) { this.tracks.push(track); }
  removeTrack(track) { this.tracks = this.tracks.filter(t => t !== track); }
}
class Connection {
  static instances = [];
  static replace;
  static remote;
  signalingState = 'stable'; transceivers = []; answers = 0;
  constructor() { Connection.instances.push(this); }
  addTransceiver(track) {
    const kind = typeof track === 'string' ? track : track.kind;
    const sender = { track: typeof track === 'string' ? null : track, setStreams() {}, replaceTrack: async next => {
      if (Connection.replace) await Connection.replace(this, next);
      sender.track = next;
    } };
    const value = { sender, receiver: { track: { kind } }, direction: 'sendrecv' }; this.transceivers.push(value); return value;
  }
  getTransceivers() { return this.transceivers; }
  createDataChannel(label) { const channel = { label, close() { this.closed = true; } }; this.channel = channel; return channel; }
  async createOffer() { return { type: 'offer', sdp: 'test offer' }; }
  async createAnswer() { this.answers++; return { type: 'answer', sdp: 'test answer' }; }
  async setLocalDescription(value) { this.localDescription = value; }
  async setRemoteDescription(value) {
    if (!this.transceivers.length) for (const kind of ['audio', 'video', 'video', 'audio']) this.addTransceiver(kind);
    if (Connection.remote) await Connection.remote(this);
    this.remoteDescription = value;
  }
  async addIceCandidate() {}
  close() { this.signalingState = 'closed'; }
}
function setup(publish = async () => {}) {
  Connection.instances = []; Connection.replace = undefined; Connection.remote = undefined;
  globalThis.MediaStream = Stream; globalThis.RTCPeerConnection = Connection;
  const captures = [], errors = [], signals = [], changes = [], media = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getDisplayMedia: async () => { const track = new Track('video'); captures.push(track); return new Stream([track]); }, getUserMedia: async () => {
    const track = new Track(); captures.push(track); return new Stream([track]);
  } } } });
  const engine = new RoomRtc((...args) => signals.push(args), (peers, local, flags) => { changes.push(flags); media.push({ peers, local }); }, message => errors.push(message), publish);
  const session = (id, peer = false, selfId = 'a') => ({ id, roomId: 'room', status: 'active', kind: 'meeting', participants: [selfId, ...(peer ? [selfId === 'a' ? 'z' : 'a'] : [])].map(deviceId => ({ deviceId, microphone: false, camera: false, screen: false })) });
  return { engine, captures, errors, signals, changes, session, media };
}

class Audio {
  static instances = [];
  currentTime = 0; state = 'running'; sources = [];
  constructor() { Audio.instances.push(this); }
  createMediaStreamDestination() { return { stream: new Stream([new Track()]) }; }
  createBuffer(_channels, count) { return { getChannelData: () => new Float32Array(count) }; }
  createBufferSource() { const source = { connect() {}, disconnect() {}, start() {}, stop() { this.stopped = true; } }; this.sources.push(source); return source; }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
}
class Socket {
  static instances = [];
  constructor() { Socket.instances.push(this); }
  close() { this.closed = true; }
  receive(data) { this.onmessage?.({ data }); }
}
function bridge() {
  Audio.instances = []; Socket.instances = [];
  globalThis.AudioContext = Audio; globalThis.WebSocket = Socket;
  globalThis.location = { protocol: 'http:', host: '127.0.0.1:1' };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ supported: true }) });
}

test('an ended session\'s failed media publish cannot stop the next session\'s microphone', async () => {
  const pending = deferred(), started = deferred(); let calls = 0;
  const qa = setup(async (_room, _id, flags) => { if (flags.microphone && ++calls === 1) { started.resolve(); await pending.promise; } });
  qa.engine.sync(qa.session('old'), 'a'); const old = qa.engine.enable('microphone', 'old'); await started.promise;
  qa.engine.sync(qa.session('new'), 'a'); await qa.engine.enable('microphone', 'new');
  pending.reject(new Error('old session disappeared')); await old;
  assert.equal(qa.captures[0].readyState, 'ended'); assert.equal(qa.captures[1].readyState, 'live');
  assert.equal(qa.changes.at(-1).microphone, true); assert.deepEqual(qa.errors, []); qa.engine.dispose();
});

test('a failed old replaceTrack cannot release media acquired after leaving and rejoining', async () => {
  const pending = deferred(), started = deferred(); const qa = setup();
  qa.engine.sync(qa.session('old', true), 'a'); await flush(); const oldPeer = Connection.instances[0];
  Connection.replace = async (pc, track) => { if (pc === oldPeer && track) { started.resolve(); await pending.promise; } };
  const old = qa.engine.enable('microphone', 'old'); await started.promise;
  qa.engine.sync(qa.session('new', true), 'a'); await qa.engine.enable('microphone', 'new');
  pending.reject(new Error('closed peer')); await old;
  assert.equal(oldPeer.signalingState, 'closed'); assert.equal(qa.captures[1].readyState, 'live');
  assert.equal(qa.changes.at(-1).microphone, true); assert.deepEqual(qa.errors, []); qa.engine.dispose();
});

test('late permission approval releases only its own capture; late denial is silent after leaving', async () => {
  const pending = deferred(); const qa = setup(); let first = true;
  navigator.mediaDevices.getUserMedia = async () => { if (first) { first = false; return pending.promise; } const track = new Track(); qa.captures.push(track); return new Stream([track]); };
  qa.engine.sync(qa.session('old'), 'a'); const old = qa.engine.enable('microphone', 'old');
  qa.engine.sync(qa.session('new'), 'a'); await qa.engine.enable('microphone', 'new'); const late = new Track(); pending.resolve(new Stream([late])); await old;
  assert.equal(late.readyState, 'ended'); assert.equal(qa.captures[0].readyState, 'live');
  const denied = deferred(); navigator.mediaDevices.getUserMedia = () => denied.promise;
  qa.engine.sync(qa.session('denied'), 'a'); const request = qa.engine.enable('microphone', 'denied'); qa.engine.sync(undefined);
  denied.reject(new Error('permission dismissed')); await request; assert.deepEqual(qa.errors, []); qa.engine.dispose();
});

test('an old pending SDP operation cannot answer after a participant leaves or a new session starts', async () => {
  const pending = deferred(), started = deferred(); const qa = setup();
  qa.engine.sync(qa.session('old', true, 'z'), 'z'); const oldPeer = Connection.instances[0];
  Connection.remote = async pc => { if (pc === oldPeer) { started.resolve(); await pending.promise; } };
  qa.engine.signal('old', 'a', { type: 'offer', sdp: 'test offer' }); await started.promise;
  qa.engine.sync(qa.session('new', true, 'z'), 'z'); pending.resolve(); await flush();
  assert.equal(oldPeer.answers, 0); assert.deepEqual(qa.signals, []); assert.deepEqual(qa.errors, []); qa.engine.dispose();
});

test('device sound uses a separate fourth slot; screen stop closes its socket and all captures', async () => {
  bridge(); const qa = setup(), published = [];
  const original = navigator.mediaDevices.getDisplayMedia;
  navigator.mediaDevices.getDisplayMedia = async constraints => { assert.equal(constraints.audio, false); return original(); };
  qa.engine.sync(qa.session('meeting', true), 'a'); await qa.engine.toggle('screen');
  const pc = Connection.instances[0]; assert.deepEqual(pc.transceivers.map(t => t.receiver.track.kind), ['audio', 'video', 'video', 'audio']);
  const pending = qa.engine.setScreenAudio(true); await flush();
  const socket = Socket.instances[0]; socket.receive('{"type":"ready"}'); await pending;
  const audio = pc.transceivers[3].sender.track;
  assert.equal(qa.changes.at(-1).screenAudio, true); assert.equal(pc.transceivers[0].sender.track, null);
  await qa.engine.toggle('screen');
  assert.equal(socket.closed, true); assert.equal(audio.readyState, 'ended'); assert.equal(Audio.instances[0].state, 'closed');
  assert.equal(qa.changes.at(-1).screen, false); assert.equal(qa.changes.at(-1).screenAudio, false);
  assert.equal(pc.transceivers[2].sender.track, null); assert.equal(pc.transceivers[3].sender.track, null);
  qa.engine.dispose(); assert.deepEqual(published, []);
});

test('leaving while device audio starts prevents stale socket approval from reopening it', async () => {
  bridge(); const qa = setup(); qa.engine.sync(qa.session('old', true), 'a'); await qa.engine.toggle('screen');
  const pending = qa.engine.setScreenAudio(true); await flush(); const socket = Socket.instances[0];
  qa.engine.sync(qa.session('new', true), 'a'); socket.receive('{"type":"ready"}'); await pending;
  assert.equal(socket.closed, true); assert.equal(Audio.instances[0].state, 'closed'); assert.equal(qa.changes.at(-1).screenAudio, false);
  assert.equal(qa.media.at(-1).local[3].getTracks().length, 0); assert.deepEqual(qa.errors, []); qa.engine.dispose();
});

test('an old pending screen-audio stop cannot disable a new session screen', async () => {
  bridge(); const qa = setup(); qa.engine.sync(qa.session('old', true), 'a'); await qa.engine.toggle('screen');
  const opening = qa.engine.setScreenAudio(true); await flush(); Socket.instances[0].receive('{"type":"ready"}'); await opening;
  const pending = deferred(), started = deferred(), oldPc = Connection.instances[0];
  Connection.replace = async (pc, track) => { if (pc === oldPc && track === null) { started.resolve(); await pending.promise; } };
  const stopping = qa.engine.toggle('screen'); await started.promise;
  qa.engine.sync(qa.session('new', true), 'a'); await qa.engine.toggle('screen'); const currentScreen = qa.captures.at(-1);
  pending.resolve(); await stopping;
  assert.equal(currentScreen.readyState, 'live'); assert.equal(qa.changes.at(-1).screen, true); assert.deepEqual(qa.errors, []); qa.engine.dispose();
});

test('microphone refuses a capture without active echo cancellation and selects all-device AEC when opening the source', async () => {
  const qa = setup(); qa.engine.sync(qa.session('meeting'), 'a'); const denied = new Track(); denied.getSettings = () => ({ echoCancellation: false });
  navigator.mediaDevices.getUserMedia = async constraints => { assert.equal(constraints.audio.echoCancellation, true); return new Stream([denied]); };
  await assert.rejects(qa.engine.toggle('microphone'), /回声消除/); assert.equal(denied.readyState, 'ended'); assert.equal(qa.changes.at(-1).microphone, false);
  navigator.mediaDevices.getSupportedConstraints = () => ({ echoCancellation: true });
  const allowed = new Track(); allowed.getSettings = () => ({ echoCancellation: 'all' });
  allowed.applyConstraints = async () => { throw new Error('An open boolean source cannot switch to system loopback AEC'); };
  navigator.mediaDevices.getUserMedia = async constraints => { assert.equal(constraints.audio.echoCancellation.exact, 'all'); return new Stream([allowed]); }; await qa.engine.toggle('microphone');
  assert.equal(allowed.readyState, 'live'); assert.equal(qa.changes.at(-1).microphone, true); qa.engine.dispose();
});

test('microphone requires supported AEC, avoids automatic echo amplification and falls back from unsupported all mode', async () => {
  const qa = setup(); qa.engine.sync(qa.session('meeting'), 'a');
  navigator.mediaDevices.getSupportedConstraints = () => ({ echoCancellation: true });
  const track = new Track(), requested = [];
  track.getSettings = () => ({ echoCancellation: true });
  navigator.mediaDevices.getUserMedia = async constraints => {
    requested.push(constraints.audio.echoCancellation);
    if (constraints.audio.echoCancellation.exact === 'all') throw Object.assign(new Error('unsupported mode'), { name: 'OverconstrainedError', constraint: 'echoCancellation' });
    assert.equal(constraints.audio.autoGainControl, false); assert.equal(constraints.audio.noiseSuppression, true);
    assert.deepEqual(constraints.audio.channelCount, { ideal: 1 });
    return new Stream([track]);
  };
  await qa.engine.toggle('microphone');
  assert.deepEqual(requested, [{ exact: 'all' }, { exact: true }]);
  assert.equal(track.readyState, 'live'); assert.equal(qa.changes.at(-1).microphone, true); qa.engine.dispose();
});

test('camera permission rejection and busy hardware report their actual recovery paths', async () => {
  const qa = setup(); qa.engine.sync(qa.session('meeting'), 'a');
  navigator.mediaDevices.getUserMedia = async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); };
  await assert.rejects(qa.engine.toggle('camera'), /Windows 隐私设置/);
  navigator.mediaDevices.getUserMedia = async () => { throw Object.assign(new Error('busy'), { name: 'NotReadableError' }); };
  await assert.rejects(qa.engine.toggle('camera'), /关闭其他占用/);
  assert.equal(qa.changes.at(-1).camera, false); qa.engine.dispose();
});

test('unsupported AEC after leaving cannot reopen the microphone, and permission errors are never retried', async () => {
  const qa = setup(); qa.engine.sync(qa.session('meeting'), 'a');
  navigator.mediaDevices.getSupportedConstraints = () => ({ echoCancellation: true });
  let requests = 0;
  navigator.mediaDevices.getUserMedia = async () => { requests++; throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); };
  await assert.rejects(qa.engine.toggle('microphone'), /权限未获批准/);
  assert.equal(requests, 1); assert.equal(qa.changes.at(-1).microphone, false);
  const pending = deferred(), started = deferred();
  navigator.mediaDevices.getUserMedia = async () => { requests++; started.resolve(); return pending.promise; };
  const opening = qa.engine.toggle('microphone'); await started.promise; qa.engine.sync(undefined);
  pending.reject(Object.assign(new Error('unsupported mode'), { name: 'OverconstrainedError', constraint: 'echoCancellation' })); await opening;
  assert.equal(requests, 2); assert.deepEqual(qa.errors, []); qa.engine.dispose();
});

test('Android device audio is authorized, bounded, played once and flushed on mute or disconnect', async () => {
  bridge(); const qa = setup(), session = qa.session('meeting', true); qa.engine.sync(session, 'a');
  const channel = Connection.instances[0].channel;
  const packet = new ArrayBuffer(1928), view = new DataView(packet); view.setUint32(0, 0x4e524131); view.setUint32(4, 48000);
  channel.onmessage({ data: packet }); assert.equal(Audio.instances.length, 0);
  session.participants[1].screen = true; session.participants[1].screenAudio = true; qa.engine.sync(session, 'a');
  for (let i = 0; i < 100; i++) channel.onmessage({ data: packet });
  assert.equal(Audio.instances.length, 1); const audio = Audio.instances[0];
  assert.ok(audio.sources.length > 0 && audio.sources.length <= 13, 'burst latency must be capped');
  assert.equal(qa.media.at(-1).peers[0].screenAudio.getTracks().length, 1);
  session.participants[1].screenAudio = false; qa.engine.sync(session, 'a');
  assert.ok(audio.sources.every(source => source.stopped));
  channel.onmessage({ data: packet }); assert.ok(audio.sources.every(source => source.stopped));
  qa.engine.dispose(); assert.equal(audio.state, 'closed'); assert.equal(channel.closed, true);
});

test('failed device sound preserves the screen and releases unexpected browser audio', async () => {
  bridge(); const qa = setup(); globalThis.fetch = async () => ({ ok: true, json: async () => ({ supported: false, reason: 'unsupported' }) });
  const video = new Track('video'), extra = new Track(); navigator.mediaDevices.getDisplayMedia = async () => new Stream([video, extra]);
  qa.engine.sync(qa.session('meeting'), 'a'); await qa.engine.toggle('screen');
  assert.equal(extra.readyState, 'ended'); await assert.rejects(qa.engine.setScreenAudio(true), /unsupported/);
  assert.equal(video.readyState, 'live'); assert.equal(qa.changes.at(-1).screen, true); assert.equal(qa.changes.at(-1).screenAudio, false);
  qa.engine.signal('meeting', 'a', { type: 'offer', sdp: 'self' }); assert.equal(Connection.instances.length, 0); qa.engine.dispose();
});

function nativeCamera() {
  bridge();
  globalThis.window = {};
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }), captureStream: () => new Stream([new Track('video')]) }) };
  globalThis.createImageBitmap = async () => ({ width: 1280, height: 720, close() {} });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ supported: true }) });
  const qa = setup();
  navigator.mediaDevices.getUserMedia = async () => { throw new Error('Native desktop camera must not use the browser capture service'); };
  const clean = () => { qa.engine.dispose(); delete globalThis.window; delete globalThis.document; delete globalThis.createImageBitmap; };
  return { ...qa, clean };
}

test('native desktop camera uses the existing camera slot and releases its socket and track when disabled', async () => {
  const qa = nativeCamera();
  try {
    qa.engine.sync(qa.session('meeting', true), 'a'); const opening = qa.engine.toggle('camera'); await flush();
    const socket = Socket.instances[0]; socket.receive(new ArrayBuffer(16)); await opening;
    const track = qa.media.at(-1).local[1].getVideoTracks()[0];
    assert.equal(track.readyState, 'live'); assert.equal(qa.changes.at(-1).camera, true);
    assert.equal(Connection.instances[0].getTransceivers()[1].sender.track, track);
    await qa.engine.toggle('camera'); assert.equal(socket.closed, true); assert.equal(track.readyState, 'ended');
    assert.equal(Connection.instances[0].getTransceivers()[1].sender.track, null);
    assert.deepEqual(qa.errors, []);
  } finally { qa.clean(); }
});

test('leaving while native camera consent is pending cancels capture without enabling the next meeting camera', async () => {
  const qa = nativeCamera();
  try {
    qa.engine.sync(qa.session('old'), 'a'); const opening = qa.engine.toggle('camera'); await flush();
    const socket = Socket.instances[0]; qa.engine.sync(qa.session('new'), 'a'); await opening;
    socket.receive(new ArrayBuffer(16)); await flush();
    assert.equal(socket.closed, true); assert.equal(qa.changes.at(-1).camera, false);
    assert.equal(qa.media.at(-1).local[1].getTracks().length, 0); assert.deepEqual(qa.errors, []);
  } finally { qa.clean(); }
});

test('an old native image decode releases its bitmap without touching the next meeting camera', async () => {
  const qa = nativeCamera(), bitmap = deferred(); let calls = 0, disposed = false;
  globalThis.createImageBitmap = async () => ++calls === 1 ? bitmap.promise : ({ width: 640, height: 480, close() {} });
  try {
    qa.engine.sync(qa.session('old'), 'a'); const old = qa.engine.toggle('camera'); await flush(); Socket.instances[0].receive(new ArrayBuffer(16)); await flush();
    qa.engine.sync(qa.session('new'), 'a'); await old;
    const current = qa.engine.toggle('camera'); await flush(); Socket.instances[1].receive(new ArrayBuffer(16)); await current;
    const track = qa.media.at(-1).local[1].getVideoTracks()[0];
    bitmap.resolve({ width: 1280, height: 720, close() { disposed = true; } }); await flush();
    assert.equal(disposed, true); assert.equal(track.readyState, 'live'); assert.equal(qa.changes.at(-1).camera, true); assert.deepEqual(qa.errors, []);
  } finally { qa.clean(); }
});

test('denied native camera consent reports the denial and closes capture without browser fallback', async () => {
  const qa = nativeCamera();
  try {
    qa.engine.sync(qa.session('meeting'), 'a'); const opening = qa.engine.toggle('camera'); await flush();
    Socket.instances[0].receive(JSON.stringify({ type: 'error', error: '摄像头权限未获批准，请在应用的媒体授权中选择允许后重试。' }));
    await assert.rejects(opening, /媒体授权/); assert.equal(Socket.instances[0].closed, true);
    assert.equal(qa.changes.at(-1).camera, false); assert.equal(qa.media.at(-1).local[1].getTracks().length, 0);
  } finally { qa.clean(); }
});

test('late native capability response after leaving cannot open a camera socket', async () => {
  const qa = nativeCamera(), response = deferred(); globalThis.fetch = () => response.promise;
  try {
    qa.engine.sync(qa.session('old'), 'a'); const opening = qa.engine.toggle('camera'); qa.engine.sync(undefined);
    response.resolve({ ok: true, json: async () => ({ supported: true }) }); await opening;
    assert.equal(Socket.instances.length, 0); assert.deepEqual(qa.errors, []);
  } finally { qa.clean(); }
});

test('leaving during native capability JSON decoding cannot overwrite the next capture resource', async () => {
  const qa = nativeCamera(), body = deferred(), started = deferred();
  globalThis.fetch = async () => ({ ok: true, json: () => { started.resolve(); return body.promise; } });
  try {
    qa.engine.sync(qa.session('old'), 'a'); const opening = qa.engine.toggle('camera'); await started.promise;
    qa.engine.sync(qa.session('new'), 'a'); body.resolve({ supported: true }); await opening;
    assert.equal(Socket.instances.length, 0); assert.equal(qa.changes.at(-1).camera, false); assert.deepEqual(qa.errors, []);
  } finally { qa.clean(); }
});
