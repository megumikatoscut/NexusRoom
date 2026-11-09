import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { roomApi } from '../api';
import { useRoom } from '../context';
import { RoomRtc } from './rtc';
import type { CommunicationSession, CommunicationState, MediaFlags, MediaKey, PeerMedia, RtcSignal } from './types';

interface Channel { socket?: WebSocket; timer?: ReturnType<typeof setTimeout>; ping?: ReturnType<typeof setInterval>; stopped: boolean; ready: boolean }
interface ActionResult { ok: boolean; session?: CommunicationSession }
interface CommunicationContextValue {
  states: Record<string, CommunicationState>; connections: Record<string, boolean>;
  session?: CommunicationSession; selfId: string; peers: PeerMedia[]; local: MediaStream[];
  media: MediaFlags; error: string; action: (room: string, path: string, body?: unknown) => Promise<ActionResult>;
  speaker: boolean; toggleSpeaker: () => void;
  toggle: (key: MediaKey) => Promise<void>; call: (room: string, targetId: string) => Promise<void>;
  screenAudioPreferred: boolean; setScreenAudio: (enabled: boolean) => Promise<void>; resumePlayback: () => void;
  accept: (room: string, sessionId: string) => Promise<void>; clearError: () => void;
}
const Context = createContext<CommunicationContextValue>(null!);
const emptyMedia: MediaFlags = { microphone: false, camera: false, screen: false, screenAudio: false };

export function CommunicationProvider({ children }: { children: ReactNode }) {
  const { state: roomState, notify } = useRoom();
  const [states, setStates] = useState<Record<string, CommunicationState>>({});
  const [connections, setConnections] = useState<Record<string, boolean>>({});
  const [peers, setPeers] = useState<PeerMedia[]>([]), [local, setLocal] = useState<MediaStream[]>([]);
  const [media, setMedia] = useState<MediaFlags>(emptyMedia), [error, setError] = useState('');
  const [speaker, setSpeaker] = useState(true);
  const [screenAudioPreferred, setScreenAudioPreferred] = useState(false);
  const channels = useRef(new Map<string, Channel>());
  // Socket/action callbacks are authoritative; a delayed React render must not
  // replace their newer state with a previously rendered snapshot.
  const currentStates = useRef(states);
  const revisions = useRef(new Map<string, number>());
  const rtc = useRef<RoomRtc | null>(null);
  const failure = useCallback((message: string) => { setError(message); notify(message, true); }, [notify]);
  const syncCurrent = useCallback(() => {
    for (const state of Object.values(currentStates.current)) {
      const channel = channels.current.get(state.roomId);
      if (!channel?.ready || channel.stopped || channel.socket?.readyState !== WebSocket.OPEN) continue;
      const own = state.sessions.find(item => item.status !== 'ended' && item.participants.some(p => p.deviceId === state.selfId));
      if (own) { rtc.current?.sync(own, state.selfId); return; }
    }
    rtc.current?.sync(undefined);
  }, []);

  useEffect(() => {
    const engine = new RoomRtc(
      (room, sessionId, targetId, signal) => {
        const socket = channels.current.get(room)?.socket;
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'signal', sessionId, targetId, signal }));
      },
      (nextPeers, nextLocal, flags, preferred) => { setPeers(nextPeers); setLocal(nextLocal); setMedia(flags); setScreenAudioPreferred(preferred); },
      failure,
      async (room, sessionId, flags) => { await roomApi(room, `/api/communication/sessions/${encodeURIComponent(sessionId)}/media`, flags); },
    );
    rtc.current = engine;
    const sockets = channels.current;
    return () => {
      engine.dispose(); rtc.current = null;
      for (const channel of sockets.values()) { channel.stopped = true; clearTimeout(channel.timer); clearInterval(channel.ping); channel.socket?.close(); }
      sockets.clear();
    };
  }, [failure]);

  // Keep every room's listener alive while navigating, so a phone can call the PC
  // even when the control centre currently displays a different room.
  const roomIds = roomState?.rooms.map(room => room.id).sort().join(',');
  useEffect(() => {
    if (roomIds === undefined) return;
    const wanted = new Set(roomIds ? roomIds.split(',') : []);
    for (const [room, channel] of channels.current) if (!wanted.has(room)) {
      channel.stopped = true; channel.ready = false; clearTimeout(channel.timer); clearInterval(channel.ping); channel.socket?.close(); channels.current.delete(room);
      revisions.current.set(room, (revisions.current.get(room) ?? 0) + 1);
      const next = { ...currentStates.current }; delete next[room]; currentStates.current = next; syncCurrent();
      setStates(old => { const next = { ...old }; delete next[room]; return next; });
      setConnections(old => { const next = { ...old }; delete next[room]; return next; });
    }
    for (const room of wanted) {
      if (channels.current.has(room)) continue;
      const channel: Channel = { stopped: false, ready: false }; channels.current.set(room, channel);
      const connect = () => {
        if (channel.stopped) return;
        const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/communication/ws?roomId=${encodeURIComponent(room)}`);
        channel.socket = socket;
        socket.onopen = () => {
          if (channel.stopped || channel.socket !== socket) { socket.close(); return; }
          clearInterval(channel.ping);
          channel.ping = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' })); }, 15000);
        };
        socket.onmessage = event => {
          if (channel.stopped || channel.socket !== socket) return;
          try {
            const message = JSON.parse(event.data) as { type: string; state?: CommunicationState; sessionId?: string; fromId?: string; signal?: RtcSignal; error?: string; message?: string };
            if (message.type === 'state' && message.state?.roomId === room) {
              const next = message.state;
              channel.ready = true;
              revisions.current.set(room, (revisions.current.get(room) ?? 0) + 1);
              currentStates.current = { ...currentStates.current, [room]: next };
              // Process the session immediately, before an ICE/SDP frame in the
              // same socket can overtake React's next render/effect.
              syncCurrent();
              setStates(old => ({ ...old, [room]: next })); setConnections(old => ({ ...old, [room]: true }));
            } else if (message.type === 'signal' && message.sessionId && message.fromId && message.signal) {
              rtc.current?.signal(message.sessionId, message.fromId, message.signal);
            } else if (message.type === 'error') failure(message.error ?? message.message ?? '会议信令被拒绝');
          } catch { failure('会议连接收到了无效的服务响应'); }
        };
        socket.onerror = () => socket.close();
        socket.onclose = () => {
          if (channel.stopped || channel.socket !== socket) return;
          channel.ready = false; clearInterval(channel.ping);
          revisions.current.set(room, (revisions.current.get(room) ?? 0) + 1);
          setConnections(old => ({ ...old, [room]: false }));
          const previous = currentStates.current[room];
          if (previous) {
            const next = { ...previous, activeSessionId: '', sessions: [], invitations: [] };
            currentStates.current = { ...currentStates.current, [room]: next }; setStates(old => ({ ...old, [room]: next }));
          }
          syncCurrent();
          channel.timer = setTimeout(connect, 1800);
        };
      };
      connect();
    }
  }, [roomIds, failure, syncCurrent]);

  const ownState = Object.values(states).find(value => value.sessions.some(s => s.status !== 'ended' && s.participants.some(p => p.deviceId === value.selfId)));
  const session = ownState?.sessions.find(s => s.status !== 'ended' && s.participants.some(p => p.deviceId === ownState.selfId));
  const selfId = ownState?.selfId ?? '';
  useEffect(() => { syncCurrent(); if (!session) setError(''); }, [session, selfId, syncCurrent]);

  const action = useCallback(async (room: string, path: string, body: unknown = {}) => {
    const revision = revisions.current.get(room) ?? 0;
    const channel = channels.current.get(room), socket = channel?.socket;
    const response = await roomApi<ActionResult>(room, '/api/communication' + path, body);
    if (response.session && channel?.ready && !channel.stopped && channels.current.get(room) === channel
      && channel.socket === socket && socket?.readyState === WebSocket.OPEN && revision === (revisions.current.get(room) ?? 0)) {
      const result = response.session;
      const previous = currentStates.current[room];
      if (previous) {
        const next = { ...previous, sessions: [...previous.sessions.filter(s => s.id !== result.id), result] };
        currentStates.current = { ...currentStates.current, [room]: next }; setStates(old => ({ ...old, [room]: next }));
        syncCurrent();
      }
    }
    return response;
  }, [syncCurrent]);
  useEffect(() => { setScreenAudioPreferred(false); }, [session?.id]);
  const toggle = useCallback(async (key: MediaKey) => { setError(''); try { await rtc.current?.toggle(key); } catch (e) { failure((e as Error).message); } }, [failure]);
  const setScreenAudio = useCallback(async (enabled: boolean) => {
    setError(''); setScreenAudioPreferred(enabled);
    try { await rtc.current?.setScreenAudio(enabled); } catch (e) { setScreenAudioPreferred(false); failure((e as Error).message); }
  }, [failure]);
  const connectMicrophone = useCallback(async (room: string, id: string) => {
    const channel = channels.current.get(room), state = currentStates.current[room];
    const own = state?.sessions.find(item => item.id === id && item.kind === 'call' && item.status !== 'ended'
      && item.participants.some(p => p.deviceId === state.selfId));
    if (!own || !channel?.ready || channel.stopped || channel.socket?.readyState !== WebSocket.OPEN) return;
    syncCurrent();
    try { await rtc.current?.enable('microphone', id); } catch (e) { failure((e as Error).message); }
  }, [failure, syncCurrent]);
  const call = useCallback(async (room: string, targetId: string) => {
    setError(''); const result = await action(room, '/calls', { targetId });
    if (result.session) await connectMicrophone(room, result.session.id);
  }, [action, connectMicrophone]);
  const accept = useCallback(async (room: string, id: string) => {
    setError(''); const result = await action(room, `/calls/${encodeURIComponent(id)}/decision`, { accept: true });
    if (result.session) await connectMicrophone(room, result.session.id);
  }, [action, connectMicrophone]);
  return <Context.Provider value={{ states, connections, session, selfId, peers, local, media, speaker, toggleSpeaker: () => { rtc.current?.resumePlayback(); setSpeaker(value => !value); }, screenAudioPreferred, setScreenAudio, resumePlayback: () => rtc.current?.resumePlayback(), error, action, toggle, call, accept, clearError: () => setError('') }}>{children}</Context.Provider>;
}
export const useCommunication = () => useContext(Context);
