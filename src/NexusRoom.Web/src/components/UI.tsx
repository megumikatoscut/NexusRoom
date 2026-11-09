import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X, Smartphone, ArrowUpRight, ShieldCheck, LoaderCircle } from 'lucide-react';
import { useRoom } from '../context';
export function Status({ online, label }: { online: boolean; label?: string }) { return <span className={`status ${!online ? 'offline' : label === '忙碌' ? 'busy' : label === '工作' ? 'working' : 'online'}`}><i />{label ?? (online ? '在线' : '离线')}</span>; }
export function Empty({ title = '连接你的第一台 Android 设备', detail = '在手机上打开 NexusRoom，扫描房间二维码。所有共享和控制权限都由你决定。', action = true }: { title?: string; detail?: string; action?: boolean }) {
  const { setInvite } = useRoom();
  return <div className="empty"><div className="empty-orbit"><Smartphone size={38} strokeWidth={1.5} /><span><ShieldCheck size={16}/></span></div><h3>{title}</h3><p>{detail}</p>{action && <button className="btn secondary" onClick={() => setInvite(true)}>添加 Android 设备 <ArrowUpRight size={16}/></button>}</div>;
}
export function Modal({ title, children, close, wide = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { const d = ref.current; d?.showModal(); return () => d?.close(); }, []);
  return <dialog ref={ref} aria-labelledby={titleId} className={`modal ${wide ? 'wide' : ''}`} onCancel={close} onClick={e => { if (e.target === e.currentTarget) close(); }}><header><h2 id={titleId}>{title}</h2><button className="icon-btn" aria-label="关闭" onClick={close}><X size={20}/></button></header>{children}</dialog>;
}
export function Busy({ text = '处理中…' }: { text?: string }) { return <span className="inline"><LoaderCircle size={16} className="spin"/>{text}</span>; }
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
