import { useState } from 'react';
import { Monitor, ShieldCheck, X, Check, Square, ArrowUpRight } from 'lucide-react';
import { api } from '../api';
import { useRoom } from '../context';
import type { PcRemotePermissions } from '../types';

export const pcRemotePermissionLabels: [keyof PcRemotePermissions, string][] = [
  ['screen', '查看电脑画面'], ['control', '鼠标与键盘操作'], ['audio', '电脑播放声音'], ['clipboard', '剪贴板传输'],
];

export function PcRemoteNotice() {
  const { state, act, switchRoom } = useRoom();
  const [busy, setBusy] = useState(false);
  const remote = state?.host.remote, session = remote?.session;
  if (!state || !session) return null;
  const sameRoom = session.roomId === state.room.id, pending = session.state === 'pending';
  const decide = (allow: boolean) => {
    setBusy(true);
    void act(() => api('/api/pc/remote/decision', { sessionId: session.sessionId, allow }), allow ? '已允许本次电脑远程访问' : '已拒绝本次电脑远程访问').finally(() => setBusy(false));
  };
  return <section className={`pc-remote-notice ${pending ? 'pending' : 'active'}`} aria-label="电脑远程访问" role={pending ? 'alert' : 'region'}>
    <span className="pc-remote-symbol"><Monitor size={23}/></span>
    <div className="pc-remote-content">
      <strong>{pending ? '手机请求访问这台电脑' : session.state === 'approved' ? '电脑远程访问已批准，等待连接' : '这台电脑正在远程共享'}</strong>
      <p><b>{session.deviceName}</b> · 房间「{session.roomName}」</p>
      {sameRoom && pending && <><p>将共享电脑桌面，包括屏幕上的窗口与通知。请确认发起设备；本次请求将在 60 秒内过期。</p><div className="pc-remote-grants">{pcRemotePermissionLabels.filter(([key]) => remote.permissions[key]).map(([key, label]) => <span key={key}><ShieldCheck size={13}/>{label}</span>)}</div>{!remote.permissions.control && <small>仅查看画面，手机不能操作鼠标或键盘。</small>}</>}
      {sameRoom && !pending && <p>{remote.permissions.control ? '手机可操作电脑。' : '手机仅查看画面。'}你可随时结束共享，撤销权限也会立即结束会话。</p>}
      {!sameRoom && <p>前往此房间处理请求或结束共享。{!pending && '当前房间的电脑状态为忙碌。'}</p>}
      {session.error && <p className="danger">{session.error}</p>}
    </div>
    <div className="pc-remote-actions">{sameRoom ? pending ? <><button className="btn secondary" disabled={busy} onClick={() => decide(false)}><X size={16}/>拒绝电脑远程访问</button><button className="btn primary" disabled={busy} onClick={() => decide(true)}><Check size={16}/>允许本次电脑远程访问</button></> : <button className="btn destructive" disabled={busy} onClick={() => { setBusy(true); void act(() => api('/api/pc/remote/stop', {}), '电脑远程共享已结束').finally(() => setBusy(false)); }}><Square size={14}/>结束电脑远程共享</button> : <button className="btn secondary" disabled={busy || !state.rooms.some(room => room.id === session.roomId)} onClick={() => { setBusy(true); void switchRoom(session.roomId).finally(() => setBusy(false)); }}>前往「{session.roomName}」<ArrowUpRight size={16}/></button>}</div>
  </section>;
}
