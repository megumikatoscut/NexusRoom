import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, CameraOff, Check, LockKeyhole, Maximize2, Minimize2, MessageSquare, Mic, MicOff, MonitorUp, Phone, PhoneOff, Plus, Users, Volume2, VolumeX, X } from 'lucide-react';
import { useRoom } from '../context';
import { useCommunication } from '../communication/context';
import { Field, Modal } from '../components/UI';
import { time } from '../api';
import type { CommunicationDevice, CommunicationSession, PeerMedia } from '../communication/types';

function Stream({ stream, label, mute = false, video = false, resume }: { stream?: MediaStream; label: string; mute?: boolean; video?: boolean; resume?: () => void }) {
  const ref = useRef<HTMLVideoElement>(null), [blocked, setBlocked] = useState(false);
  const playbackAttempt = useRef(0);
  const trackCount = stream?.getTracks().length ?? 0;
  useEffect(() => {
    const element = ref.current;
    if (!element || !stream || !trackCount) return;
    let active = true;
    element.srcObject = stream;
    const play = () => { const attempt = ++playbackAttempt.current; void element.play().then(() => { if (active && playbackAttempt.current === attempt) setBlocked(false); }).catch(() => { if (active && playbackAttempt.current === attempt) setBlocked(true); }); };
    play(); stream.addEventListener('addtrack', play);
    return () => { active = false; playbackAttempt.current++; stream.removeEventListener('addtrack', play); element.pause(); element.srcObject = null; };
  }, [stream, trackCount]);
  useEffect(() => {
    const element = ref.current;
    if (mute || !trackCount || !element?.paused) return;
    let active = true;
    const attempt = ++playbackAttempt.current;
    void element.play().then(() => { if (active && playbackAttempt.current === attempt) setBlocked(false); }).catch(() => { if (active && playbackAttempt.current === attempt) setBlocked(true); });
    return () => { active = false; };
  }, [mute, stream, trackCount]);
  return <><video ref={ref} aria-label={label} autoPlay playsInline muted={mute} className={video ? 'meeting-video' : 'meeting-audio'} />{blocked && !mute && <button className="btn secondary" onClick={() => { resume?.(); const element = ref.current, attempt = ++playbackAttempt.current; void element?.play().then(() => { if (ref.current === element && playbackAttempt.current === attempt) setBlocked(false); }).catch(() => {}); }}>播放 {label}</button>}</>;
}

function SharedScreen({ stream, name }: { stream?: MediaStream; name: string }) {
  const stage = useRef<HTMLDivElement>(null), [full, setFull] = useState(false), [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const changed = () => setFull(document.fullscreenElement === stage.current);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setExpanded(false); };
    document.addEventListener('fullscreenchange', changed); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('fullscreenchange', changed); document.removeEventListener('keydown', escape); };
  }, []);
  useEffect(() => {
    if (!expanded) return;
    const previousFocus = document.activeElement as HTMLElement | null, previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; stage.current?.querySelector('button')?.focus();
    const focus = (event: KeyboardEvent) => { if (event.key === 'Tab') { event.preventDefault(); stage.current?.querySelector('button')?.focus(); } };
    document.addEventListener('keydown', focus);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', focus); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [expanded]);
  const toggleFull = async () => {
    if (full) { await document.exitFullscreen().catch(() => {}); return; }
    if (expanded) { setExpanded(false); return; }
    if (!stage.current?.requestFullscreen) { setExpanded(true); return; }
    try { await stage.current.requestFullscreen(); } catch { setExpanded(true); }
  };
  const viewingFull = full || expanded;
  const content = <div ref={stage} className={`shared-screen ${expanded ? 'screen-expanded' : ''}`} role={expanded ? 'dialog' : undefined} aria-modal={expanded || undefined} aria-label={expanded ? `${name} 屏幕共享全屏` : undefined} onDoubleClick={() => void toggleFull()}>
    <Stream stream={stream} label={`${name} 屏幕共享`} mute video />
    <span><MonitorUp size={14}/> {name} 的屏幕</span>
    <button className="shared-screen-fullscreen" aria-label={viewingFull ? `退出 ${name} 屏幕全屏` : `全屏查看 ${name} 屏幕`} onClick={() => void toggleFull()}>{viewingFull ? <Minimize2 size={17}/> : <Maximize2 size={17}/>}<span>{viewingFull ? '退出全屏' : '全屏查看'}</span></button>
  </div>;
  // Page entry animations create a stacking context. The fallback viewer must
  // sit outside it, above the floating Agent launcher and room navigation.
  return expanded ? createPortal(content, document.body) : content;
}

function ParticipantTile({ session, peer, deviceId, self, local }: { session: CommunicationSession; peer?: PeerMedia; deviceId: string; self: boolean; local: MediaStream[] }) {
  const person = session.participants.find(p => p.deviceId === deviceId)!;
  const showCamera = person.camera || (self && !!local[1]?.getVideoTracks().some(t => t.readyState === 'live'));
  const showScreen = person.screen || (self && !!local[2]?.getVideoTracks().some(t => t.readyState === 'live'));
  const connection = self ? '本机' : peer?.connection === 'connected' ? '已连接' : peer?.connection === 'failed' ? '连接失败' : '连接中';
  return <article className={`participant-tile ${showScreen ? 'has-screen' : ''}`}>
    {showScreen && <SharedScreen stream={self ? local[2] : peer?.screen} name={person.name}/>}
    <div className="participant-camera">{showCamera ? <Stream stream={self ? local[1] : peer?.camera} label={`${person.name} 摄像头`} mute video /> : <div className="participant-avatar">{person.name.slice(0, 1)}</div>}</div>
    <div className="participant-label"><strong>{person.name}{self ? '（你）' : ''}</strong><span>{deviceId === session.hostId && session.kind === 'meeting' ? '主持人 · ' : ''}{connection}</span><span title={person.microphone ? '麦克风已开启' : '已静音'}>{person.microphone ? <Mic size={16}/> : <MicOff size={16}/>}</span></div>
  </article>;
}

export function Communication() {
  const { state, notify, act } = useRoom();
  const communication = useCommunication();
  const [create, setCreate] = useState(false), [invite, setInvite] = useState(false), [title, setTitle] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public'), [chosen, setChosen] = useState<string[]>([]);
  const [chat, setChat] = useState(''), [busy, setBusy] = useState(false);
  const speaker = communication.speaker;
  const room = state?.room.id ?? '', data = communication.states[room], connected = communication.connections[room];
  const session = communication.session?.roomId === room ? communication.session : undefined;
  const history = useRef<HTMLDivElement>(null), follow = useRef(true);
  const messageCount = session?.messages.length ?? 0;
  useEffect(() => { if (follow.current) history.current?.scrollTo({ top: history.current.scrollHeight }); }, [messageCount, session?.id]);
  useEffect(() => { setCreate(false); setInvite(false); setChosen([]); setChat(''); follow.current = true; }, [room]);
  if (!state || !room) return null;
  const others = data?.devices.filter(d => d.id !== data.selfId) ?? [];
  const available = others.filter(d => d.online && d.communicationOnline && !d.busy && !session?.participants.some(p => p.deviceId === d.id));
  const run = async (work: () => Promise<unknown>) => { setBusy(true); try { await act(work); } finally { setBusy(false); } };
  const choose = (id: string) => setChosen(old => old.includes(id) ? old.filter(item => item !== id) : [...old, id]);
  const deviceChoices = (devices: CommunicationDevice[]) => <div className="meeting-invite-list">{devices.length ? devices.map(d => <label key={d.id}><input type="checkbox" checked={chosen.includes(d.id)} onChange={() => choose(d.id)}/><span><strong>{d.name}</strong><small>{d.system} · {d.model}</small></span></label>) : <p>暂无可邀请的在线设备。</p>}</div>;
  return <>
    <div className="page-heading"><div><h1>通话与会议</h1><p>在房间里交流声音、画面和想法。</p></div><button className="btn primary" disabled={!connected || !!communication.session || busy} onClick={() => { setTitle(''); setChosen([]); setCreate(true); }}><Plus size={17}/>创建会议</button></div>
    {!connected && <div className="callout warning" role="status">正在连接房间通信服务…</div>}
    {communication.error && <div className="callout error" role="alert">{communication.error}<button className="text-btn" onClick={communication.clearError}>关闭提示</button></div>}
    {communication.session && !session && <div className="callout warning">你已在另一个房间进行通话或会议。结束当前会话后可在这里发起。</div>}
    {session ? <section className="meeting-workspace">
      <div className="meeting-title"><div><span className="eyebrow">{session.kind === 'call' ? '私人音频电话' : session.visibility === 'private' ? '私密会议 · 仅受邀设备' : '公开会议 · 房间成员可加入'}</span><h2>{session.title}</h2></div><span className="status online"><i/>{session.status === 'ringing' ? '等待对方接听 · 45 秒内有效' : `${session.participants.length} / 8 位成员`}</span></div>
      {session.status === 'ringing' ? <div className="calling-state"><Phone size={38}/><h3>正在呼叫 {data?.devices.find(d => d.id === session.calleeId)?.name ?? '对方设备'}…</h3><p>对方接听后建立音频连接。</p></div> : <div className="meeting-grid">{session.participants.map(person => <ParticipantTile key={person.deviceId} session={session} deviceId={person.deviceId} self={person.deviceId === data?.selfId} peer={communication.peers.find(p => p.id === person.deviceId)} local={communication.local}/>)}</div>}
      <div className="meeting-toolbar"><button className={`btn ${communication.media.microphone ? 'secondary' : 'primary'}`} aria-pressed={communication.media.microphone} onClick={() => void communication.toggle('microphone')}>{communication.media.microphone ? <Mic size={17}/> : <MicOff size={17}/>} {communication.media.microphone ? '静音' : '开启麦克风'}</button><button className="btn secondary" aria-pressed={speaker} onClick={communication.toggleSpeaker}>{speaker ? <Volume2 size={17}/> : <VolumeX size={17}/>} {speaker ? '关闭扬声器' : '开启扬声器'}</button>
        {session.kind === 'meeting' && <><button className="btn secondary" aria-pressed={communication.media.camera} onClick={() => void communication.toggle('camera')}>{communication.media.camera ? <Camera size={17}/> : <CameraOff size={17}/>} {communication.media.camera ? '关闭摄像头' : '开启摄像头'}</button><button className="btn secondary" aria-pressed={communication.media.screen} onClick={() => void communication.toggle('screen')}><MonitorUp size={17}/> {communication.media.screen ? '停止共享屏幕' : '共享屏幕'}</button><label className="screen-audio-option"><input type="checkbox" checked={communication.screenAudioPreferred} onChange={event => void communication.setScreenAudio(event.target.checked)}/><span>共享设备声音{communication.media.screen && communication.media.screenAudio ? <small>已共享</small> : null}</span></label>{session.hostId === data?.selfId && <button className="btn secondary" onClick={() => { setChosen([]); setInvite(true); }}><Users size={17}/>邀请设备</button>}</>}
        <button className="btn destructive" disabled={busy} onClick={() => void run(() => communication.action(room, `/sessions/${session.id}/leave`))}><PhoneOff size={17}/>{session.kind === 'call' ? session.status === 'ringing' ? '取消呼叫' : '挂断' : session.hostId === data?.selfId ? '结束会议' : '退出会议'}</button></div>
      <p className="fine-print">麦克风、摄像头和屏幕由你决定是否开启。{session.kind === 'meeting' ? '共享设备声音可随时切换，会议自身声音不会转发。屏幕可点击全屏查看；主持人离开时会议结束。' : ''}</p>
      {session.status === 'active' && session.kind === 'meeting' && <div className="meeting-bottom"><section className="panel"><h2><Users size={17}/>会议成员</h2><div className="meeting-member-list">{session.participants.map(person => <div key={person.deviceId}><span>{person.name}{person.deviceId === session.hostId ? ' · 主持人' : ''}</span>{session.hostId === data?.selfId && person.deviceId !== data.selfId && <button className="text-btn danger" disabled={busy} aria-label={`移出 ${person.name}`} onClick={() => void run(() => communication.action(room, `/meetings/${session.id}/remove`, { deviceId: person.deviceId }))}>移出</button>}</div>)}</div></section><section className="panel meeting-chat"><h2><MessageSquare size={17}/>会议聊天</h2><div className="meeting-chat-history" ref={history} role="log" aria-label="会议消息" onScroll={() => { const element = history.current; if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60; }}>{session.messages.length ? session.messages.map(message => <div key={message.id} className={message.senderId === data?.selfId ? 'own' : ''}><small>{message.senderName} · {time(message.sentAt)}</small><p>{message.text}</p></div>) : <p className="muted">和会议成员打个招呼吧。</p>}</div><form onSubmit={event => { event.preventDefault(); if (!chat.trim()) return; const text = chat.trim(); void run(async () => { await communication.action(room, `/sessions/${session.id}/chat`, { text }); setChat(''); follow.current = true; }); }}><input aria-label="会议聊天内容" maxLength={2000} placeholder="发送给会议成员…" value={chat} onChange={event => setChat(event.target.value)}/><button className="btn primary" disabled={busy || !chat.trim()}>发送</button></form></section></div>}
    </section> : <>
      <section className="panel"><h2><Phone size={18}/>私人电话</h2><p>发送一对一音频通话请求，对方同意后即可交流。</p><div className="communication-devices">{others.length ? others.map(device => <div key={device.id}><div className="communication-device-avatar">{device.system === 'Windows' ? 'W' : 'A'}</div><div><strong>{device.name}</strong><small>{device.model} · {device.online && device.communicationOnline ? device.busy ? '通话或会议中' : '可通话' : '未连接'}</small></div><button className="btn secondary" disabled={!connected || !device.online || !device.communicationOnline || device.busy || busy || !!communication.session} onClick={() => void run(() => communication.call(room, device.id))}><Phone size={16}/>呼叫</button></div>) : <p className="muted">连接房间设备后即可发起电话。</p>}</div></section>
      <section className="panel communication-meetings"><h2><Users size={18}/>房间会议</h2><p>公开会议对所有房间设备可见。私密会议通过邀请加入。</p>{data?.sessions.filter(item => item.kind === 'meeting' && item.status === 'active').length ? data.sessions.filter(item => item.kind === 'meeting' && item.status === 'active').map(meeting => <div className="meeting-list-item" key={meeting.id}><div>{meeting.visibility === 'private' ? <LockKeyhole size={20}/> : <Users size={20}/>}<span><strong>{meeting.title}</strong><small>{meeting.participants.length} / 8 位成员 · {meeting.visibility === 'private' ? '私密' : '公开'}</small></span></div><button className="btn secondary" disabled={!connected || busy || !!communication.session} onClick={() => void run(() => communication.action(room, `/meetings/${meeting.id}/join`))}>加入会议</button></div>) : <div className="communication-empty">暂时没有可加入的会议</div>}</section>
    </>}
    {create && <Modal title="创建视频会议" close={() => setCreate(false)}><form onSubmit={event => { event.preventDefault(); void run(async () => { await communication.action(room, '/meetings', { title: title.trim() || '房间会议', visibility, inviteeIds: chosen }); setCreate(false); notify('会议已创建，受邀设备同意后加入'); }); }}><Field label="会议名称"><input autoFocus maxLength={80} value={title} placeholder="例如：项目讨论" onChange={event => setTitle(event.target.value)}/></Field><Field label="会议权限"><select value={visibility} onChange={event => setVisibility(event.target.value as 'public' | 'private')}><option value="public">公开 · 房间内设备可自由加入</option><option value="private">私密 · 仅邀请设备同意后加入</option></select></Field><Field label="邀请在线设备" hint="创建后仍可继续邀请。最多 8 位成员。">{deviceChoices(available)}</Field><div className="modal-actions"><button type="button" className="btn secondary" onClick={() => setCreate(false)}>取消</button><button className="btn primary" disabled={busy || chosen.length > 7}>创建会议</button></div></form></Modal>}
    {invite && session && <Modal title="邀请设备加入会议" close={() => setInvite(false)}>{deviceChoices(available)}<div className="modal-actions"><button className="btn secondary" onClick={() => setInvite(false)}>取消</button><button className="btn primary" disabled={busy || !chosen.length} onClick={() => void run(async () => { await communication.action(room, `/meetings/${session.id}/invite`, { deviceIds: chosen }); setInvite(false); notify('会议邀请已发送'); })}>发送邀请</button></div></Modal>}
  </>;
}

export function CommunicationNotice() {
  const { state, switchRoom, setPage, page, act } = useRoom();
  const communication = useCommunication(), [busy, setBusy] = useState(false);
  const pendingCall = Object.values(communication.states).flatMap(data => data.sessions.filter(s => s.status === 'ringing' && s.calleeId === data.selfId).map(session => ({ data, session })))[0];
  const pendingInvite = Object.values(communication.states).flatMap(data => data.invitations.map(invitation => ({ data, invitation })))[0];
  const roomName = (id: string) => state?.rooms.find(room => room.id === id)?.name ?? '房间';
  const show = async (room: string) => { if (state?.room.id !== room) await switchRoom(room); setPage('communication'); };
  const run = async (work: () => Promise<unknown>) => { setBusy(true); try { await act(work); } finally { setBusy(false); } };
  return <>
    <div className="communication-playback">{communication.session?.status === 'active' && communication.peers.map(peer => {
      const person = communication.session!.participants.find(p => p.deviceId === peer.id), name = person?.name ?? '房间设备';
      return <div key={peer.id}><Stream stream={peer.audio} label={`${name} 音频`} mute={!communication.speaker || !person?.microphone} resume={communication.resumePlayback}/><Stream stream={peer.screenAudio} label={`${name} 共享设备声音`} mute={!communication.speaker || !person?.screen || !person?.screenAudio} resume={communication.resumePlayback}/></div>;
    })}</div>
    {communication.session && (page !== 'communication' || state?.room.id !== communication.session.roomId) && <div className="communication-notice"><span><Phone size={17}/>{roomName(communication.session.roomId)} · {communication.session.title}{communication.session.status === 'ringing' ? ' · 等待接听' : ' · 进行中'}</span><button className="text-btn" onClick={() => void show(communication.session!.roomId)}>查看会话</button></div>}
    {pendingCall ? <Modal title="收到私人电话" close={() => { if (!busy) void run(() => communication.action(pendingCall.data.roomId, `/calls/${pendingCall.session.id}/decision`, { accept: false })); }}><div className="incoming-call"><Phone size={42}/><h3>{pendingCall.data.devices.find(d => d.id === pendingCall.session.callerId)?.name ?? '房间设备'}</h3><p>{roomName(pendingCall.data.roomId)} · 音频通话请求</p><small>请求在 45 秒后自动失效。接听后可随时静音或挂断。</small></div><div className="modal-actions"><button className="btn secondary" disabled={busy} onClick={() => void run(() => communication.action(pendingCall.data.roomId, `/calls/${pendingCall.session.id}/decision`, { accept: false }))}><X size={16}/>拒绝</button><button className="btn primary" disabled={busy} onClick={() => void run(async () => { await communication.accept(pendingCall.data.roomId, pendingCall.session.id); await show(pendingCall.data.roomId); })}><Phone size={16}/>接听</button></div></Modal>
    : pendingInvite && <Modal title="收到会议邀请" close={() => { if (!busy) void run(() => communication.action(pendingInvite.data.roomId, `/invitations/${pendingInvite.invitation.id}/decision`, { accept: false })); }}><div className="incoming-call"><Users size={42}/><h3>{pendingInvite.invitation.title}</h3><p>{pendingInvite.invitation.hostName} 邀请你加入{pendingInvite.invitation.visibility === 'private' ? '私密' : '公开'}会议</p><small>{roomName(pendingInvite.data.roomId)} · 邀请 2 分钟内有效 · 加入后媒体默认关闭</small></div><div className="modal-actions"><button className="btn secondary" disabled={busy} onClick={() => void run(() => communication.action(pendingInvite.data.roomId, `/invitations/${pendingInvite.invitation.id}/decision`, { accept: false }))}>拒绝</button><button className="btn primary" disabled={busy} onClick={() => void run(async () => { await communication.action(pendingInvite.data.roomId, `/invitations/${pendingInvite.invitation.id}/decision`, { accept: true }); await show(pendingInvite.data.roomId); })}><Check size={16}/>加入会议</button></div></Modal>}
  </>;
}
