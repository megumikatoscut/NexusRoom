import type { CommunicationSession, MediaFlags, MediaKey, PeerMedia, RtcSignal } from './types';

interface Peer {
  id: string; sessionId: string; generation: number;
  pc: RTCPeerConnection; media: PeerMedia; queue: Promise<void>;
  candidates: RTCIceCandidateInit[]; offered: boolean;
  screenChannel?: RTCDataChannel; pcm?: PcmStream;
}
const emptyFlags = (): MediaFlags => ({ microphone: false, camera: false, screen: false, screenAudio: false });
const slots: (keyof MediaFlags)[] = ['microphone', 'camera', 'screen', 'screenAudio'];
const mediaStreams = () => slots.map(() => new MediaStream());

// PCM is sent only for Android playback capture and the local Windows process
// loopback bridge. Route it through a single MediaStream, never directly to the
// speakers, so the common playback element owns muting and echo reference.
class PcmStream {
  readonly context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  readonly destination = this.context.createMediaStreamDestination();
  readonly sources = new Set<AudioBufferSourceNode>();
  private nextTime = 0;
  private closed = false;
  get stream() { return this.destination.stream; }
  resume() { if (!this.closed) void this.context.resume().catch(() => {}); }
  push(packet: ArrayBuffer, offset = 0) {
    if (this.closed || packet.byteLength <= offset || (packet.byteLength - offset) % 2 || packet.byteLength - offset > 19200) return;
    // Bound latency and memory if a socket is bursty or playback is suspended.
    if (this.context.state !== 'running' || this.sources.size >= 24 || this.nextTime > this.context.currentTime + .24) { this.resume(); return; }
    const view = new DataView(packet), count = (packet.byteLength - offset) / 2;
    const buffer = this.context.createBuffer(1, count, 48000), samples = buffer.getChannelData(0);
    for (let i = 0; i < count; i++) samples[i] = view.getInt16(offset + i * 2, true) / 32768;
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.destination);
    this.sources.add(source); source.onended = () => { this.sources.delete(source); source.disconnect(); };
    this.nextTime = Math.max(this.nextTime, this.context.currentTime + .025);
    source.start(this.nextTime); this.nextTime += count / 48000;
  }
  clear() {
    for (const source of this.sources) { source.onended = null; try { source.stop(); } catch { /* already stopped */ } source.disconnect(); }
    this.sources.clear(); this.nextTime = 0;
  }
  close() { if (this.closed) return; this.closed = true; this.clear(); this.destination.stream.getTracks().forEach(track => track.stop()); void this.context.close(); }
}

// Stable Unified Plan slots: 0 microphone, 1 camera, 2 display, 3 device audio.
// Tracks can be replaced after consent without renegotiating or sharing remote input.
export class RoomRtc {
  private session: CommunicationSession | undefined;
  private selfId = '';
  private peers = new Map<string, Peer>();
  private tracks: Partial<Record<keyof MediaFlags, MediaStreamTrack>> = {};
  private operations: Partial<Record<keyof MediaFlags, Promise<void>>> = {};
  private streams = mediaStreams();
  private screenAudioPreferred = false;
  private screenSocket?: WebSocket;
  private screenPcm?: PcmStream;
  private screenCancel?: () => void;
  private screenAudioGeneration = 0;
  private nativeCamera?: { close: () => void };
  private generation = 0;
  private flags: MediaFlags = emptyFlags();
  private disposed = false;
  constructor(
    private send: (room: string, sessionId: string, target: string, signal: RtcSignal) => void,
    private changed: (peers: PeerMedia[], local: MediaStream[], flags: MediaFlags, screenAudioPreferred: boolean) => void,
    private failure: (message: string) => void,
    private publish: (room: string, sessionId: string, flags: MediaFlags) => Promise<void>,
  ) {}

  sync(session: CommunicationSession | undefined, selfId = '') {
    if (this.disposed) return;
    if (session?.id !== this.session?.id || (session && this.selfId !== selfId)) {
      this.clear(); this.session = session; this.selfId = selfId;
    } else this.session = session;
    if (!session || session.status === 'ended') { this.clear(); this.session = undefined; return; }
    if (session.status !== 'active') return;
    const ids = new Set(session.participants.map(p => p.deviceId).filter(id => id !== selfId));
    for (const [id, peer] of this.peers) if (!ids.has(id)) { this.closePeer(peer); this.peers.delete(id); }
    for (const id of ids) if (!this.peers.has(id)) this.createPeer(id);
    for (const [id, peer] of this.peers) {
      const person = session.participants.find(p => p.deviceId === id);
      if (!person?.screen || !person.screenAudio) peer.pcm?.clear();
    }
    const me = session.participants.find(p => p.deviceId === selfId);
    if (me && (me.microphone !== this.flags.microphone || me.camera !== this.flags.camera || me.screen !== this.flags.screen || !!me.screenAudio !== this.flags.screenAudio)) {
      const generation = this.generation;
      void this.publish(session.roomId, session.id, { ...this.flags }).catch(error => {
        if (generation === this.generation && this.session?.id === session.id) this.failure(error.message);
      });
    }
    this.emit();
  }

  private createPeer(id: string) {
    const session = this.session!;
    // NexusRoom is a LAN workspace. Host ICE candidates require no public STUN/TURN service.
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
    const peer: Peer = { id, sessionId: session.id, generation: this.generation, pc, media: { id, audio: new MediaStream(), camera: new MediaStream(), screen: new MediaStream(), screenAudio: new MediaStream(), connection: 'new' }, queue: Promise.resolve(), candidates: [], offered: false };
    this.peers.set(id, peer);
    // An answerer adopts the offer's transceivers. Pre-created unassociated
    // transceivers are not reused by setRemoteDescription in Unified Plan.
    if (this.selfId < id) {
      slots.forEach((key, index) => pc.addTransceiver(this.tracks[key] ?? (index === 0 || index === 3 ? 'audio' : 'video'), { direction: session.kind === 'call' && index > 0 ? 'inactive' : 'sendrecv', streams: [this.streams[index]] }));
      if (session.kind === 'meeting') this.attachScreenChannel(peer, pc.createDataChannel('nr-screen-audio', { ordered: false, maxRetransmits: 0 }));
    }
    pc.ondatachannel = event => this.attachScreenChannel(peer, event.channel);
    pc.onicecandidate = event => { if (event.candidate && this.session?.id === session.id && this.peers.get(id) === peer) this.send(session.roomId, session.id, id, { type: 'ice', candidate: event.candidate.toJSON() }); };
    pc.ontrack = event => {
      if (!this.currentPeer(peer)) return;
      const slot = pc.getTransceivers().indexOf(event.transceiver);
      if (slot < 0 || slot > 3 || (event.track.kind === 'audio') !== (slot === 0 || slot === 3)) return;
      // Android sends playback capture over the negotiated data channel; never
      // play that source again through an otherwise empty MID3 receiver.
      if (slot === 3 && peer.pcm) return;
      const stream = slot === 0 ? peer.media.audio : slot === 2 ? peer.media.screen : slot === 3 ? peer.media.screenAudio : peer.media.camera;
      if (!stream.getTracks().includes(event.track)) stream.addTrack(event.track);
      event.track.onmute = () => { if (this.currentPeer(peer)) this.emit(); };
      event.track.onunmute = () => { if (this.currentPeer(peer)) this.emit(); };
      event.track.onended = () => { if (this.currentPeer(peer)) { stream.removeTrack(event.track); this.emit(); } };
      this.emit();
    };
    pc.onconnectionstatechange = () => {
      if (!this.currentPeer(peer)) return;
      peer.media.connection = pc.connectionState; this.emit();
      if (pc.connectionState === 'failed') this.failure('媒体连接失败，请检查局域网是否允许设备互相连接，或退出后重新加入。');
    };
    // Exactly one endpoint offers; the answerer adopts its media slots.
    if (this.selfId < id) {
      peer.offered = true;
      this.enqueue(peer, async () => {
        const offer = await pc.createOffer(); if (!this.currentPeer(peer)) return;
        await pc.setLocalDescription(offer);
        if (pc.localDescription && this.currentPeer(peer)) this.send(session.roomId, session.id, id, { type: 'offer', sdp: pc.localDescription.sdp });
      });
    }
  }

  signal(sessionId: string, fromId: string, signal: RtcSignal) {
    if (fromId === this.selfId || sessionId !== this.session?.id || this.session.status !== 'active' || !this.session.participants.some(p => p.deviceId === fromId)) return;
    if (!this.peers.has(fromId)) this.createPeer(fromId);
    const peer = this.peers.get(fromId)!;
    const session = this.session;
    this.enqueue(peer, async () => {
      if (signal.type === 'ice') {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(signal.candidate); else if (peer.candidates.length < 256) peer.candidates.push(signal.candidate);
        return;
      }
      if (signal.type === 'offer' && this.selfId < fromId) throw new Error('收到不符合协商顺序的媒体请求');
      await peer.pc.setRemoteDescription({ type: signal.type, sdp: signal.sdp });
      if (!this.currentPeer(peer)) return;
      for (const candidate of peer.candidates.splice(0)) {
        if (!this.currentPeer(peer)) return;
        await peer.pc.addIceCandidate(candidate);
      }
      if (signal.type === 'offer') {
        if (!this.currentPeer(peer)) return;
        const transceivers = peer.pc.getTransceivers();
        if (![3, 4].includes(transceivers.length) || transceivers.some((t, i) => t.receiver.track.kind !== (i === 0 || i === 3 ? 'audio' : 'video'))) throw new Error('媒体轨道顺序无效');
        await Promise.all(transceivers.map(async (transceiver, index) => {
          transceiver.direction = session.kind === 'call' && index > 0 ? 'inactive' : 'sendrecv';
          transceiver.sender.setStreams(this.streams[index]);
          await transceiver.sender.replaceTrack(this.tracks[slots[index]] ?? null);
        }));
        if (!this.currentPeer(peer)) return;
        const answer = await peer.pc.createAnswer(); if (!this.currentPeer(peer)) return;
        await peer.pc.setLocalDescription(answer);
        if (this.currentPeer(peer) && peer.pc.localDescription) this.send(session.roomId, session.id, fromId, { type: 'answer', sdp: peer.pc.localDescription.sdp });
      }
    });
  }

  private enqueue(peer: Peer, operation: () => Promise<void>) {
    peer.queue = peer.queue.then(async () => { if (this.currentPeer(peer)) await operation(); }).catch(error => {
      if (this.currentPeer(peer)) this.failure('媒体协商失败：' + (error instanceof Error ? error.message : String(error)));
    });
  }
  private currentPeer(peer: Peer) {
    return !this.disposed && peer.generation === this.generation && this.session?.id === peer.sessionId
      && this.peers.get(peer.id) === peer && peer.pc.signalingState !== 'closed';
  }
  private closePeer(peer: Peer) {
    peer.pc.ontrack = null; peer.pc.onicecandidate = null; peer.pc.onconnectionstatechange = null; peer.pc.ondatachannel = null;
    if (peer.screenChannel) { peer.screenChannel.onmessage = null; peer.screenChannel.close(); }
    peer.pcm?.close();
    for (const stream of [peer.media.audio, peer.media.camera, peer.media.screen, peer.media.screenAudio]) for (const track of stream.getTracks()) {
      track.onmute = null; track.onunmute = null; track.onended = null;
    }
    peer.pc.close();
  }

  private attachScreenChannel(peer: Peer, channel: RTCDataChannel) {
    if (!this.currentPeer(peer) || this.session?.kind !== 'meeting' || channel.label !== 'nr-screen-audio' || peer.screenChannel) { channel.close(); return; }
    peer.screenChannel = channel; channel.binaryType = 'arraybuffer';
    channel.onmessage = event => {
      const person = this.session?.participants.find(p => p.deviceId === peer.id);
      if (!this.currentPeer(peer) || !person?.screen || !person.screenAudio || !(event.data instanceof ArrayBuffer)) return;
      const packet = event.data as ArrayBuffer;
      if (packet.byteLength !== 1928) return;
      const view = new DataView(packet);
      if (view.getUint32(0) !== 0x4e524131 || view.getUint32(4) !== 48000) return;
      if (!peer.pcm) {
        peer.pcm = new PcmStream(); peer.media.screenAudio = peer.pcm.stream; peer.pcm.resume(); this.emit();
      }
      peer.pcm.push(packet, 8);
    };
  }

  resumePlayback() { this.screenPcm?.resume(); for (const peer of this.peers.values()) peer.pcm?.resume(); }

  enable(key: MediaKey, sessionId: string): Promise<void> {
    if (this.session?.id !== sessionId || this.disposed || this.tracks[key]) return Promise.resolve();
    return this.toggle(key);
  }

  toggle(key: MediaKey): Promise<void> {
    this.resumePlayback();
    if (this.operations[key]) return this.operations[key]!;
    const operation = this.changeTrack(key).finally(() => { if (this.operations[key] === operation) delete this.operations[key]; });
    this.operations[key] = operation;
    return operation;
  }

  private async changeTrack(key: MediaKey) {
    const session = this.session;
    if (!session || session.status === 'ended') throw new Error('请先发起通话或加入会议');
    if (key !== 'microphone' && session.kind === 'call') throw new Error('私人电话只支持音频');
    if (this.tracks[key]) { await this.disable(key); return; }
    const generation = this.generation;
    let stream: MediaStream;
    try {
      stream = key === 'screen'
        ? await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false })
        : key === 'camera' ? await this.captureCamera(session, generation)
          : await this.captureMicrophone(generation);
    } catch (error) {
      if (generation !== this.generation || this.disposed) return;
      if (key === 'screen') throw new Error('屏幕共享未开启，请在系统选择器中选择要共享的屏幕或窗口。');
      const hardware = key === 'camera' ? '摄像头' : '麦克风', name = error instanceof Error ? error.name : '';
      if (key === 'camera' && error instanceof Error && name === 'NativeCameraError') throw error;
      if (name === 'NotAllowedError' || name === 'SecurityError') throw new Error(`${hardware}权限未获批准，请允许应用的媒体授权，并在 Windows 隐私设置中开启${hardware}及桌面应用访问权限，然后重试。`);
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') throw new Error(`未找到可用的${hardware}，请连接设备并检查系统设备设置。`);
      if (name === 'NotReadableError' || name === 'TrackStartError') throw new Error(`${hardware}暂时无法使用，请关闭其他占用它的应用并检查设备连接后重试。`);
      throw new Error(`无法开启${hardware}，请检查系统权限与可用设备。${name ? ' ' + name : ''}`);
    }
    if (generation !== this.generation || this.disposed) { stream.getTracks().forEach(track => track.stop()); return; }
    const track = key === 'microphone' ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
    if (!track) { stream.getTracks().forEach(item => item.stop()); throw new Error('系统没有提供可用的媒体轨道'); }
    // The screen picker is deliberately video-only; all device audio uses the
    // process-isolated bridge. Release any unexpected extra capture tracks.
    stream.getTracks().forEach(item => { if (item !== track) item.stop(); });
    if (key === 'microphone') {
      try {
        if (generation !== this.generation || this.disposed) { track.stop(); return; }
        if (track.getSettings?.().echoCancellation === false) throw new Error('当前麦克风未启用回声消除，请检查设备设置或切换麦克风后重试。');
      } catch (error) {
        track.stop();
        if (generation !== this.generation || this.disposed) return;
        throw error;
      }
    }
    if (track.readyState !== 'live') { track.stop(); throw new Error('媒体设备已停止，请检查设备连接后重试。'); }
    this.tracks[key] = track; this.flags[key] = true;
    const index = slots.indexOf(key);
    this.streams[index].addTrack(track);
    track.onended = () => { if (this.tracks[key] === track) void this.disable(key).catch(error => this.failure(error.message)); };
    try {
      await Promise.all([...this.peers.values()].map(peer => peer.pc.getTransceivers()[index]?.sender.replaceTrack(track)));
      if (generation !== this.generation || this.tracks[key] !== track) { track.stop(); return; }
      this.emit();
      if (this.session?.status === 'active') await this.publish(session.roomId, session.id, { ...this.flags });
      if (key === 'screen' && this.screenAudioPreferred && generation === this.generation && this.tracks.screen === track) {
        try { await this.setScreenAudio(true); } catch (error) { if (generation === this.generation) this.failure((error as Error).message); }
      }
    } catch (error) {
      if (generation !== this.generation || this.tracks[key] !== track || this.disposed) { track.stop(); return; }
      await this.disable(key); throw error;
    }
  }

  private async captureMicrophone(generation: number): Promise<MediaStream> {
    const supported = navigator.mediaDevices.getSupportedConstraints?.();
    const audio: MediaTrackConstraints = { noiseSuppression: true, autoGainControl: false, channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 } };
    if (supported?.echoCancellation) {
      // Chromium selects the system loopback reference when opening the source.
      // Switching an already-open boolean AEC source to 'all' can fail even when
      // its capabilities advertise that mode, leaving only the weaker default.
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: { ...audio, echoCancellation: { exact: 'all' } } as unknown as MediaTrackConstraints, video: false });
      } catch (error) {
        if (generation !== this.generation || this.disposed) return new MediaStream();
        const failure = error as { name?: string; constraint?: string };
        // Older runtimes only accept boolean AEC. Permission/device failures
        // must reach the user without requesting capture a second time.
        if (failure.name !== 'TypeError' && !(failure.name === 'OverconstrainedError' && (!failure.constraint || failure.constraint === 'echoCancellation'))) throw error;
      }
    }
    return navigator.mediaDevices.getUserMedia({ audio: { ...audio, echoCancellation: supported?.echoCancellation ? { exact: true } : true }, video: false });
  }

  private async captureCamera(session: CommunicationSession, generation: number): Promise<MediaStream> {
    if (typeof window !== 'undefined') {
      const response = await fetch('/api/communication/camera/capability', { credentials: 'same-origin', headers: { 'X-Nexus-Request': '1', 'X-Nexus-Room': session.roomId } });
      if (generation !== this.generation || this.disposed) return new MediaStream();
      const capability = await response.json() as { supported?: boolean; title?: string };
      if (generation !== this.generation || this.disposed) return new MediaStream();
      if (!response.ok) throw new Error(capability.title ?? '会议连接已失效，请重新加入会议。');
      if (capability.supported) return this.captureNativeCamera(session, generation);
    }
    if (generation !== this.generation || this.disposed) return new MediaStream();
    return navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } }, audio: false });
  }

  private async captureNativeCamera(session: CommunicationSession, generation: number): Promise<MediaStream> {
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('无法初始化摄像头画面');
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/communication/sessions/${encodeURIComponent(session.id)}/camera/ws?roomId=${encodeURIComponent(session.roomId)}`);
    socket.binaryType = 'arraybuffer';
    let stream: MediaStream | undefined, decoding = false, closed = false, started = false;
    let settle: (error?: Error) => void = () => {};
    const nativeError = (message: string) => Object.assign(new Error(message), { name: 'NativeCameraError' });
    const resource = { close: () => {
      if (closed) return;
      closed = true; socket.close(); stream?.getTracks().forEach(track => track.stop()); settle();
    } };
    this.nativeCamera = resource;
    const current = () => !closed && !this.disposed && generation === this.generation && this.nativeCamera === resource;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => settle(nativeError('摄像头启动超时，请检查摄像头授权和设备连接后重试。')), 60000);
        settle = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
        socket.onmessage = event => {
          if (!current()) return;
          if (typeof event.data === 'string') {
            try { const message = JSON.parse(event.data) as { type?: string; error?: string }; if (message.type === 'error') settle(nativeError(message.error ?? '摄像头无法开启')); } catch { /* unknown status */ }
            return;
          }
          if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > 8 * 1024 * 1024 || decoding) return;
          decoding = true;
          void createImageBitmap(new Blob([event.data], { type: 'image/jpeg' })).then(bitmap => {
            try {
              if (!current()) return;
              if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width > 4096 || bitmap.height > 2160) throw new Error('摄像头画面尺寸不受支持');
              if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) { canvas.width = bitmap.width; canvas.height = bitmap.height; }
              context.drawImage(bitmap, 0, 0);
              if (!stream) { stream = canvas.captureStream(20); settle(); }
            } finally { bitmap.close(); }
          }).catch(() => {
            if (!current()) return;
            if (!started) settle(nativeError('摄像头画面无法读取，请重试。'));
            else void this.disable('camera').then(() => this.failure('摄像头画面已停止，请重新开启。')).catch(error => this.failure(error.message));
          }).finally(() => { decoding = false; });
        };
        socket.onerror = () => { if (current() && !started) settle(nativeError('摄像头连接失败，请重试。')); };
        socket.onclose = () => {
          if (!current()) return;
          if (!started) settle(nativeError('摄像头采集已停止，请重新开启。'));
          else void this.disable('camera').then(() => this.failure('摄像头采集已停止，请重新开启。')).catch(error => this.failure(error.message));
        };
      });
      if (!current()) { resource.close(); return new MediaStream(); }
      started = true; return stream!;
    } catch (error) {
      resource.close(); if (this.nativeCamera === resource) this.nativeCamera = undefined;
      if (generation !== this.generation || this.disposed) return new MediaStream();
      throw error;
    }
  }

  private async disable(key: MediaKey) {
    const session = this.session, generation = this.generation;
    if (key === 'screen') await this.stopScreenAudio(false);
    if (key === 'camera') { this.nativeCamera?.close(); this.nativeCamera = undefined; }
    if (generation !== this.generation || this.disposed) return;
    const index = slots.indexOf(key), track = this.tracks[key];
    delete this.tracks[key]; this.flags[key] = false;
    if (track) { track.onended = null; track.stop(); this.streams[index].removeTrack(track); }
    this.emit();
    try {
      await Promise.all([...this.peers.values()].map(peer => peer.pc.getTransceivers()[index]?.sender.replaceTrack(null)));
      if (generation === this.generation && session?.status === 'active') await this.publish(session.roomId, session.id, { ...this.flags });
    } catch (error) { if (generation === this.generation && !this.disposed) throw error; }
  }

  async setScreenAudio(enabled: boolean) {
    this.screenAudioPreferred = enabled; this.resumePlayback(); this.emit();
    if (!enabled) { await this.stopScreenAudio(true); return; }
    if (!this.tracks.screen || this.flags.screenAudio) return;
    if (this.operations.screenAudio) return this.operations.screenAudio;
    const operation = this.startScreenAudio().catch(error => {
      if (this.operations.screenAudio === operation) { this.screenAudioPreferred = false; this.emit(); }
      throw error;
    }).finally(() => { if (this.operations.screenAudio === operation) delete this.operations.screenAudio; });
    this.operations.screenAudio = operation; return operation;
  }

  private async startScreenAudio() {
    const session = this.session, screen = this.tracks.screen, generation = this.generation;
    if (!session || session.kind !== 'meeting' || session.status !== 'active' || !screen || this.flags.screenAudio) return;
    const attempt = ++this.screenAudioGeneration;
    const current = () => !this.disposed && generation === this.generation && attempt === this.screenAudioGeneration && this.tracks.screen === screen && this.screenAudioPreferred;
    const response = await fetch('/api/communication/screen-audio/capability', { credentials: 'same-origin', headers: { 'X-Nexus-Request': '1', 'X-Nexus-Room': session.roomId } });
    if (!current()) return;
    const capability = await response.json() as { supported?: boolean; reason?: string; title?: string };
    if (!current()) return;
    if (!response.ok || !capability.supported) throw new Error(capability.reason ?? capability.title ?? '当前 Windows 不支持隔离会议声音的设备音频共享。屏幕画面仍在共享。');
    // Capture excludes the host/browser process tree. Whole-system browser
    // loopback cannot reliably exclude the meeting and would return its audio.
    const pcm = new PcmStream(); pcm.resume();
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/communication/sessions/${encodeURIComponent(session.id)}/screen-audio/ws?roomId=${encodeURIComponent(session.roomId)}`);
    socket.binaryType = 'arraybuffer'; this.screenSocket = socket; this.screenPcm = pcm;
    let started = false;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); if (this.screenCancel === cancel) this.screenCancel = undefined; if (error) reject(error); else resolve(); };
        const cancel = () => finish();
        const timer = setTimeout(() => finish(new Error('设备声音采集启动超时。屏幕画面仍在共享，请重试声音选项。')), 8000);
        this.screenCancel = cancel;
        socket.onmessage = event => {
          if (!current()) { finish(); return; }
          if (event.data instanceof ArrayBuffer) { pcm.push(event.data); finish(); }
          else {
            try { const message = JSON.parse(String(event.data)) as { type?: string; error?: string };
              if (message.type === 'ready') finish();
              else if (message.type === 'error') finish(new Error(message.error ?? '设备声音采集失败'));
            } catch { /* ignore an unknown bounded status packet */ }
          }
        };
        socket.onerror = () => { if (!started) finish(current() ? new Error('设备声音连接失败。屏幕画面仍在共享。') : undefined); };
        socket.onclose = event => {
          if (!started) finish(current() ? new Error(event.reason || '设备声音采集无法启动。屏幕画面仍在共享。') : undefined);
          else if (current() && this.screenSocket === socket) {
            this.screenAudioPreferred = false;
            void this.stopScreenAudio(true).then(() => this.failure(event.reason || '设备声音采集已停止，屏幕画面仍在共享。')).catch(error => this.failure(error.message));
          }
        };
      });
      if (!current()) return;
      const track = pcm.stream.getAudioTracks()[0];
      if (!track) throw new Error('系统没有提供设备声音轨道');
      this.tracks.screenAudio = track; this.streams[3].addTrack(track);
      await Promise.all([...this.peers.values()].map(peer => peer.pc.getTransceivers()[3]?.sender.replaceTrack(track)));
      if (!current()) return;
      started = true; this.flags.screenAudio = true; this.emit();
      await this.publish(session.roomId, session.id, { ...this.flags });
    } catch (error) {
      if (current()) { this.screenAudioPreferred = false; await this.stopScreenAudio(true); throw error; }
    } finally {
      if (!current() && this.screenSocket !== socket) { socket.close(); pcm.close(); }
      else if (!started) await this.stopScreenAudio(false);
    }
  }

  private releaseScreenAudio() {
    this.screenAudioGeneration++;
    delete this.operations.screenAudio;
    const socket = this.screenSocket; this.screenSocket = undefined;
    this.screenCancel?.(); this.screenCancel = undefined;
    if (socket) { socket.onmessage = null; socket.onerror = null; socket.onclose = null; socket.close(); }
    this.screenPcm?.close(); this.screenPcm = undefined;
    const track = this.tracks.screenAudio;
    if (track) { track.onended = null; track.stop(); this.streams[3].removeTrack(track); }
    delete this.tracks.screenAudio; this.flags.screenAudio = false;
  }

  private async stopScreenAudio(publish: boolean) {
    const session = this.session, generation = this.generation;
    const wasActive = this.flags.screenAudio || !!this.screenSocket;
    this.releaseScreenAudio(); this.emit();
    if (!wasActive) return;
    await Promise.all([...this.peers.values()].map(peer => peer.pc.getTransceivers()[3]?.sender.replaceTrack(null)));
    if (publish && generation === this.generation && !this.disposed && session?.status === 'active') await this.publish(session.roomId, session.id, { ...this.flags });
  }

  private emit() { if (!this.disposed) this.changed([...this.peers.values()].map(p => ({ ...p.media })), [...this.streams], { ...this.flags }, this.screenAudioPreferred); }
  private clear() {
    this.generation++;
    this.nativeCamera?.close(); this.nativeCamera = undefined;
    this.releaseScreenAudio(); this.screenAudioPreferred = false;
    for (const peer of this.peers.values()) this.closePeer(peer);
    this.peers.clear();
    Object.values(this.tracks).forEach(track => { if (track) { track.onended = null; track.stop(); } });
    this.tracks = {}; this.operations = {}; this.flags = emptyFlags(); this.streams = mediaStreams(); this.emit();
  }
  dispose() { this.clear(); this.session = undefined; this.disposed = true; }
}
