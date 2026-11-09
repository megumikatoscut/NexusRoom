import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Copy, RefreshCw, Download, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { api, roomId } from '../api';
import { useRoom } from '../context';
import type { Invitation as InvitationData } from '../types';
import { Modal } from './UI';
export function Invitation() {
  const { state, setInvite, notify, act } = useRoom(); const [invitation, setInvitation] = useState<InvitationData | null>(null), [qr, setQr] = useState(''), [address, setAddress] = useState(''), [visible, setVisible] = useState(false), [error, setError] = useState('');
  const request = useRef(0);
  const load = useCallback(async () => {
    const generation = ++request.current, requestedRoom = roomId();
    setInvitation(null); setQr(''); setError('');
    try { const value = await api<InvitationData>(`/api/invitation?address=${encodeURIComponent(address)}`); if (request.current === generation && roomId() === requestedRoom) setInvitation(value); }
    catch (e) { if (request.current === generation && roomId() === requestedRoom) setError((e as Error).message); }
  }, [address]);
  useEffect(() => { void load(); return () => { request.current++; }; }, [load]);
  useEffect(() => { let active = true; const generation = request.current; if (invitation) QRCode.toDataURL(JSON.stringify(invitation), { width: 320, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#132e2b', light: '#ffffff' } }).then(value => { if (active && generation === request.current) setQr(value); }).catch(() => { if (active && generation === request.current) setError('二维码生成失败'); }); return () => { active = false; }; }, [invitation]);
  const copy = async (value: string) => { try { await navigator.clipboard.writeText(value); notify('已复制'); } catch { notify('无法访问剪贴板，请手动选择复制', true); } };
  return <Modal title="邀请设备加入房间" close={() => setInvite(false)} wide><div className="invite-grid"><div className="qr-column">{qr ? <img src={qr} alt="包含房间连接信息的二维码" width="260" height="260"/> : <div className="qr-placeholder">{error || '正在生成二维码…'}</div>}<strong>打开 Android NexusRoom 扫一扫</strong><p>二维码包含房间密码，请仅分享给信任的设备。</p><a className="btn secondary" href="/api/android-apk" download><Download size={16}/> 下载 Android 安装包</a></div><div className="invite-detail"><span className="section-label">也可以手动连接</span><label className="field"><span>电脑地址</span><select value={address || invitation?.server || ''} onChange={e => setAddress(e.target.value)}>{state?.host.addresses.map(a => <option key={a}>{a}</option>)}</select></label><div className="invitation-code"><small>ROOM ID</small><strong>{invitation?.roomId ?? '—'}</strong><button className="icon-btn" aria-label="复制房间号" onClick={() => void copy(invitation?.roomId ?? '')}><Copy size={17}/></button></div><div className="password-line"><div><small>房间密码</small><code>{visible ? invitation?.password : '••••••••••'}</code></div><button className="icon-btn" aria-label={visible ? '隐藏密码' : '显示密码'} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={17}/> : <Eye size={17}/>}</button><button className="icon-btn" aria-label="复制密码" onClick={() => void copy(invitation?.password ?? '')}><Copy size={17}/></button></div><div className="fingerprint"><span><ShieldCheck size={15}/> 核对证书指纹</span><code>{invitation?.fingerprint}</code><button className="text-btn" onClick={() => void copy(invitation?.fingerprint ?? '')}>复制完整指纹</button></div><button className="text-btn" onClick={async () => { if (await act(() => api('/api/room/rotate', {}), '新的邀请信息已生成，旧邀请失效')) void load(); }}><RefreshCw size={14}/> 更新邀请信息</button></div></div></Modal>;
}
