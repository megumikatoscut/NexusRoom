import { useCallback, useEffect, useRef, useState } from 'react';
import { roomApi } from '../api';

export interface VoiceStatus {
  enabled: boolean;
  wakeEnabled: boolean;
  ready: boolean;
  phase: string;
  error?: string;
  roomId: string;
  profileId: string;
  workspacePath: string;
  recordingId?: string;
  recordingRoomId?: string;
  lastWake?: { eventId: string; roomId: string; detectedAt: string };
  text?: string;
}
export interface VoiceTask {
  taskId: string; wakeId: string; status: string; targetId: string;
  runId?: string; text?: string; error?: string; createdAt: string; sourceId: string;
}
type Capture = { room: string; id?: string; released: boolean; cancelled: boolean };

export function useVoice(room: string, visible: boolean, profileId: string, workspacePath: string,
  transcript: (text: string) => void, notify: (message: string, error?: boolean) => void) {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [tasks, setTasks] = useState<VoiceTask[]>([]);
  const [capturePhase, setCapturePhase] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const capture = useRef<Capture | null>(null);
  const currentRoom = useRef(room); currentRoom.current = room;
  const mounted = useRef(true);
  const callbacks = useRef({ transcript, notify }); callbacks.current = { transcript, notify };
  const refresh = useCallback(async () => {
    if (!room) return;
    const next = await roomApi<VoiceStatus>(room, '/api/voice/status');
    if (mounted.current && currentRoom.current === room) setStatus(next);
  }, [room]);
  const cancel = useCallback(() => {
    const session = capture.current;
    if (!session) return;
    session.cancelled = true;
    capture.current = null;
    if (mounted.current) setCapturePhase('');
    if (mounted.current) setStatus(previous => previous && previous.recordingId === session.id ? { ...previous, phase: 'idle', recordingId: undefined } : previous);
    if (session.id) void roomApi(session.room, '/api/voice/manual/cancel', { recordingId: session.id }).catch(() => {});
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancel(); };
  }, [cancel]);
  useEffect(() => {
    cancel(); setStatus(null); setTasks([]); setError('');
    if (!room) return;
    let active = true;
    const load = async () => {
      try {
        const [next, events] = await Promise.all([
          roomApi<VoiceStatus>(room, '/api/voice/status'),
          roomApi<VoiceTask[]>(room, '/api/voice/tasks'),
        ]);
        if (active) { setStatus(next); setTasks(events); setError(''); }
      } catch (failure) { if (active) setError(failure instanceof Error ? failure.message : '无法读取语音状态'); }
    };
    void load(); const timer = window.setInterval(() => void load(), 500);
    return () => { active = false; clearInterval(timer); cancel(); };
  }, [room, cancel]);
  useEffect(() => { if (!visible) cancel(); }, [visible, cancel]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) cancel(); };
    window.addEventListener('blur', cancel); window.addEventListener('pagehide', cancel); document.addEventListener('visibilitychange', hidden);
    return () => { window.removeEventListener('blur', cancel); window.removeEventListener('pagehide', cancel); document.removeEventListener('visibilitychange', hidden); };
  }, [cancel]);
  const finish = useCallback(async (session: Capture) => {
    if (!session.id || session.cancelled) return;
    setCapturePhase('transcribing');
    setStatus(previous => previous && previous.recordingId === session.id ? { ...previous, phase: 'transcribing' } : previous);
    try {
      const result = await roomApi<{ text: string }>(session.room, '/api/voice/manual/stop', { recordingId: session.id });
      if (!session.cancelled && mounted.current && currentRoom.current === session.room) {
        if (result.text?.trim()) callbacks.current.transcript(result.text.trim());
        else callbacks.current.notify('未识别到语音，请按住麦克风重新说话');
      }
    } catch (failure) {
      if (!session.cancelled && mounted.current && currentRoom.current === session.room)
        callbacks.current.notify(failure instanceof Error ? failure.message : '语音转写失败', true);
    } finally {
      if (capture.current === session) { capture.current = null; if (mounted.current) setCapturePhase(''); }
      void refresh().catch(() => {});
    }
  }, [refresh]);
  const press = useCallback(async () => {
    if (!room || !status?.enabled || !status.ready || capture.current || saving) return;
    const session: Capture = { room, released: false, cancelled: false };
    capture.current = session; setCapturePhase('starting'); setError('');
    try {
      const result = await roomApi<{ recordingId: string }>(room, '/api/voice/manual/start', {});
      session.id = result.recordingId;
      if (session.cancelled || currentRoom.current !== room || !mounted.current) {
        void roomApi(room, '/api/voice/manual/cancel', { recordingId: result.recordingId }).catch(() => {});
        return;
      }
      if (session.released) await finish(session);
      else setCapturePhase('recording');
    } catch (failure) {
      if (!session.cancelled && mounted.current && currentRoom.current === room)
        callbacks.current.notify(failure instanceof Error ? failure.message : '无法启动麦克风', true);
      if (capture.current === session) { capture.current = null; if (mounted.current) setCapturePhase(''); }
    }
  }, [room, status, saving, finish]);
  const release = useCallback(() => {
    const session = capture.current;
    if (!session || session.released || session.cancelled) return;
    session.released = true;
    if (session.id) void finish(session);
  }, [finish]);
  const configure = async (enabled: boolean, wakeEnabled: boolean) => {
    if (!room || saving) return;
    if (!enabled) cancel();
    setSaving(true); setError('');
    try {
      await roomApi(room, '/api/voice/settings', { enabled, wakeEnabled: enabled && wakeEnabled, profileId, workspacePath: workspacePath.trim() });
      await refresh();
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : '语音设置保存失败';
      if (mounted.current && currentRoom.current === room) { setError(message); callbacks.current.notify(message, true); }
    } finally { if (mounted.current) setSaving(false); }
  };
  const engineRecording = !!status?.recordingId && (status.recordingRoomId ?? status.roomId) === room &&
    ['recording-manual', 'recording-wake'].includes(status.phase);
  const recording = capturePhase === 'recording' ||
    (capturePhase === 'starting' ? !capture.current?.released && engineRecording : !capturePhase && engineRecording);
  return { status, tasks, capturePhase, recording, saving, error, press, release, cancel, configure };
}
