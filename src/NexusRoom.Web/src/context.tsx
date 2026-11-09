import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { api, bootstrap, roomId, setRoomId } from './api';
import type { Page, RoomState } from './types';
import type { VoiceStatus } from './voice/useVoice';

interface ContextValue { switchRoom: (id: string) => Promise<void>; state: RoomState | null; error: string; page: Page; setPage: (page: Page) => void; selected: string; select: (id: string) => void; refresh: () => Promise<void>; notify: (text: string, error?: boolean) => void; toast: { text: string; error: boolean } | null; act: (operation: () => Promise<unknown>, success?: string) => Promise<boolean>; agentOpen: boolean; setAgentOpen: (open: boolean) => void; invite: boolean; setInvite: (open: boolean) => void }
const Context = createContext<ContextValue>(null!);
export function Provider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<RoomState | null>(null), [error, setError] = useState(''), [page, navigate] = useState<Page>('overview'), [selected, select] = useState(''), [invite, setInvite] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [bootstrapped, setBootstrapped] = useState(false);
  const roomGeneration = useRef(0);
  const setPage = (next: Page) => { if (next === 'agent') { setAgentOpen(true); return; } navigate(next); };
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const notify = useCallback((text: string, error = false) => setToast({ text, error }), []);
  useEffect(() => { if (toast) { const timeout = setTimeout(() => setToast(null), 6000); return () => clearTimeout(timeout); } }, [toast]);
  const refresh = useCallback(async () => { const requested=roomId(), generation=roomGeneration.current; try { const data = await api<RoomState>('/api/state'); if(requested!==roomId()||generation!==roomGeneration.current) return; if (data.room.id !== requested) setRoomId(data.room.id); setState(data); setError(''); } catch (e) { if(requested!==roomId()||generation!==roomGeneration.current) return; if((e as Error).message.includes('房间已解散')) { setRoomId(''); } setError((e as Error).message); } }, []);
  const switchRoom = useCallback(async (id: string) => { roomGeneration.current++; setRoomId(id); select(''); setInvite(false); setState(null); setError(''); await refresh(); }, [refresh]);
  const presentedWake = useRef('');
  useEffect(() => {
    if (!bootstrapped) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const voice = await api<VoiceStatus>('/api/voice/status');
        const wake = voice.lastWake;
        if (active && wake?.eventId && presentedWake.current !== wake.eventId) {
          presentedWake.current = wake.eventId;
          if (Date.now() - Date.parse(wake.detectedAt) < 65000) {
            if (roomId() !== wake.roomId) await switchRoom(wake.roomId);
            if (active) setAgentOpen(true);
          }
        }
      } catch { /* Voice availability must not interrupt ordinary navigation. */ }
      if (active) timer = setTimeout(() => void poll(), 500);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [switchRoom, bootstrapped]);
  useEffect(() => { let live = true; let timer: ReturnType<typeof setInterval>; bootstrap().then(() => { if (!live) return; setBootstrapped(true); void refresh(); timer = setInterval(() => void refresh(), 2500); }).catch(e => setError(e.message)); return () => { live = false; clearInterval(timer); }; }, [refresh]);
  useEffect(() => { if (state && selected && !state.devices.some(d => d.id === selected)) select(state.devices[0]?.id ?? ''); }, [state, selected]);
  const act = async (operation: () => Promise<unknown>, success?: string) => { try { await operation(); await refresh(); if (success) notify(success); return true; } catch (e) { notify((e as Error).message, true); return false; } };
  return <Context.Provider value={{ switchRoom, state, error, page, setPage, selected, select, refresh, notify, toast, act, agentOpen, setAgentOpen, invite, setInvite }}>{children}</Context.Provider>;
}
export const useRoom = () => useContext(Context);
