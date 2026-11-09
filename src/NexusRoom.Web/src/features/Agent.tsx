import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Bot, ArrowUp, Square, Sparkles, ShieldCheck, Check, X, Terminal, Smartphone, Monitor, Clock3, ChevronRight, AlertCircle, GripHorizontal, Minus, FolderOpen } from 'lucide-react';
import { api, storageKey, time } from '../api';
import { useRoom } from '../context';
import { activityLabel, hostActivityLabel, type Run, type AgentMode, type AgentTarget } from '../types';
import { Status } from '../components/UI';
import { WorkspacePicker } from '../components/WorkspacePicker';
import { useVoice } from '../voice/useVoice';
import { VoiceMicrophone, VoiceSettings, VoiceRecordingIndicator } from '../voice/VoiceControls';
const toolLabels: Record<string, string> = { arrange_communication: '安排会议或通话', list_room_devices: '查看房间手机', send_file_to_phone: '通过房间发送文件到手机', pc_screenshot: '读取电脑截图', pc_click: '点击电脑', pc_text: '输入电脑文本', pc_key: '电脑按键', pc_send_file: '发送授权文件', tap: '点击屏幕', swipe: '滑动屏幕', text: '输入文本', home: '回到主页', back: '返回上一级', recents: '打开最近任务', launch_app: '启动应用', send_file: '发送文件到手机', export_photo: '传回照片', clipboard_set: '修改剪贴板', open_app_by_name: '打开应用', open_settings_page: '打开系统设置', get_page_info: '读取当前页面', click_element: '点击页面控件', set_input_text: '输入文字', get_notifications: '读取通知', find_phone_files: '查找手机文件', find_photos: '查找照片', send_file_to_pc: '发送文件到电脑', decode_recent_qr: '识别二维码', compose_email: '打开邮件编写', get_app_usage_time: '查询使用时长', send_qr_link_email: '用二维码链接起草邮件', open_url: '打开网页', open_file: '打开手机文件', share_file: '分享手机文件', append_text: '追加文字', clear_text: '清除文字', press_key: '按编辑键', recent: '打开最近任务', clipboard_get: '读取剪贴板', list_files: '列出电脑待收文件', export_photo_by_id: '导出指定照片' };
export function Agent() {
  const { state, act, setPage, agentOpen, setAgentOpen, notify } = useRoom(); const [task, setTask] = useState(''), [consent, setConsent] = useState(false), [runs, setRuns] = useState<Run[]>([]), [current, setCurrent] = useState(''), [busy, setBusy] = useState(false); const end = useRef<HTMLDivElement>(null);
  const [profiles, setProfiles] = useState<{ id: string; name: string; apiType: 'chat_completions' | 'responses'; model: string; hasKey: boolean }[]>([]), [profileId, setProfileId] = useState('');
  const [targetId, setTargetId] = useState(''), [workspacePath, setWorkspacePath] = useState(''), [pcAgentEnabled, setPcAgentEnabled] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const voice = useVoice(state?.room.id ?? '', agentOpen, profileId, workspacePath, text => setTask(previous => previous.trim() ? previous.trimEnd() + '\n' + text : text), notify);
  useEffect(() => { setWorkspaceOpen(false); }, [state?.room.id, targetId, agentOpen]);
  const [mode, setMode] = useState<AgentMode>('request');
  useEffect(() => { try { setMode(localStorage.getItem(storageKey('agent-mode:' + state?.room.id)) === 'automatic' ? 'automatic' : 'request'); } catch { setMode('request'); } }, [state?.room.id]);
  useEffect(() => { try { setTargetId(localStorage.getItem(storageKey('agent-target:' + state?.room.id)) || ''); setWorkspacePath(localStorage.getItem(storageKey('agent-workspace:' + state?.room.id)) || ''); } catch { setTargetId(''); setWorkspacePath(''); } }, [state?.room.id]);
  const chooseMode = (value: AgentMode) => { setMode(value); try { localStorage.setItem(storageKey('agent-mode:' + state?.room.id), value); } catch {} };
  const chooseTarget = (value: string) => { setTargetId(value); setCurrent(''); try { localStorage.setItem(storageKey('agent-target:' + state?.room.id), value); } catch {} };
  const chooseWorkspace = (value: string) => { setWorkspacePath(value); try { localStorage.setItem(storageKey('agent-workspace:' + state?.room.id), value); } catch {} };
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [position, setPosition] = useState(() => { try { const saved = JSON.parse(localStorage.getItem(storageKey('agent-position')) || 'null'); if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) return saved as {x: number; y: number}; } catch {} return { x: Math.max(12, innerWidth - 500), y: 86 }; });
  const [portal, setPortal] = useState<Element>(document.body), [details, setDetails] = useState(false);
  const displayedVoiceTasks = useRef(new Set<string>());
  useEffect(() => {
    const submitted = voice.tasks.find(item => item.sourceId === `pc:${state?.room.id}` && item.status === 'started' && item.runId && item.targetId && !displayedVoiceTasks.current.has(item.taskId));
    if (!submitted) return;
    voice.tasks.filter(item => item.status === 'started' && item.runId).forEach(item => displayedVoiceTasks.current.add(item.taskId));
    chooseTarget(submitted.targetId); setCurrent(submitted.runId!); setDetails(false); setAgentOpen(true);
  }, [voice.tasks]);
  useEffect(() => { if (voice.status?.lastWake?.roomId === state?.room.id) setDetails(false); }, [voice.status?.lastWake?.eventId, state?.room.id]);
  const clamp = (x: number, y: number) => ({ x: Math.max(8, Math.min(x, innerWidth - Math.min(472, innerWidth - 16) - 8)), y: Math.max(8, Math.min(y, innerHeight - Math.min(690, innerHeight - 24) - 8)) });
  useEffect(() => { const resize = () => setPosition(p => clamp(p.x, p.y)); const fullscreen = () => setPortal(document.fullscreenElement || document.body); resize(); window.addEventListener('resize', resize); document.addEventListener('fullscreenchange', fullscreen); return () => { window.removeEventListener('resize', resize); document.removeEventListener('fullscreenchange', fullscreen); }; }, []);
  useEffect(() => { try { localStorage.setItem(storageKey('agent-position'), JSON.stringify(position)); } catch {} }, [position]);
  const move = (event: PointerEvent<HTMLDivElement>) => { if (drag.current) setPosition(clamp(drag.current.left + event.clientX - drag.current.x, drag.current.top + event.clientY - drag.current.y)); };
  useEffect(() => { let active = true; setRuns([]); setCurrent(''); setConsent(false); const load = () => api<Run[]>('/api/agent/runs').then(r => { if (active) setRuns(r); }).catch(() => {}); void load(); const timer = setInterval(load, 1500); return () => { active = false; clearInterval(timer); }; }, [state?.room.id]);
  useEffect(() => {
    let active = true;
    api<{ defaultProfileId: string; pcAgentEnabled: boolean; profiles: { id: string; name: string; apiType: 'chat_completions' | 'responses'; model: string; hasKey: boolean }[] }>('/api/settings').then(value => {
      if (!active) return;
      setProfiles(value.profiles);
      setPcAgentEnabled(value.pcAgentEnabled);
      // A profile id is room-scoped. Do not carry a selection from a previous
      // room into a room that does not contain it, otherwise the next task is
      // rejected by the host with "模型方案不存在".
      setProfileId(previous => value.profiles.some(profile => profile.id === previous)
        ? previous
        : value.defaultProfileId || value.profiles[0]?.id || '');
    }).catch(() => {});
    return () => { active = false; };
  }, [state?.room.id, agentOpen]);
  useEffect(() => {
    if (!agentOpen) return;
    let active = true;
    const refresh = () => api<{ defaultProfileId: string; pcAgentEnabled: boolean; profiles: { id: string; name: string; apiType: 'chat_completions' | 'responses'; model: string; hasKey: boolean }[] }>('/api/settings').then(value => {
      if (!active) return;
      setProfiles(value.profiles);
      setPcAgentEnabled(value.pcAgentEnabled);
      setProfileId(previous => value.profiles.some(profile => profile.id === previous)
        ? previous
        : value.defaultProfileId || value.profiles[0]?.id || '');
    }).catch(() => {});
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [agentOpen, state?.room.id]);
  useEffect(() => { const box = end.current?.parentElement; if (box && box.scrollHeight - box.scrollTop - box.clientHeight < 180) box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' }); }, [runs, current, targetId]);
  if (!state) return null;
  const targets: AgentTarget[] = [
    { id: `pc:${state.room.id}`, kind: 'pc', name: `${state.host.name} (本机 Windows)`, online: state.host.online, agent: pcAgentEnabled, activity: state.host.activity ?? 'online' },
    ...state.devices.map(device => ({ id: device.id, kind: 'android' as const, name: device.name, online: device.online, agent: device.permissions.agent, activity: device.activity, device })),
  ];
  const target = targets.find(item => item.id === targetId) ?? targets[0];
  const targetRuns = runs.filter(item => item.deviceId === target.id);
  const run = targetRuns.find(item => item.id === current) ?? targetRuns[0];
  const activeRun = targetRuns.find(item => item.status === 'running');
  const running = !!activeRun, shownMode = activeRun?.mode ?? mode;
  const canStart = target.online && target.agent && target.activity !== 'busy' && (target.kind !== 'pc' || target.activity === 'online');
  const start = async () => { if (!profiles.some(profile => profile.id === profileId && profile.hasKey)) { notify('请选择已配置 API Key 的房间模型方案', true); return; } setBusy(true); try { await act(async () => { const result = await api<Run>('/api/agent/runs', { targetId: target.id, deviceId: target.kind === 'android' ? target.id : '', task, mode, profileId, workspacePath: target.kind === 'pc' ? workspacePath.trim() : '' }); setRuns(previous => [result, ...previous]); setCurrent(result.id); setTask(''); }); } finally { setBusy(false); } };
  return createPortal(<><button className={`agent-launcher ${agentOpen ? 'is-hidden' : ''}`} aria-label="打开 Agent 悬浮窗" onClick={() => setAgentOpen(true)}><Bot size={22}/><span>Agent</span>{state.approvals.length > 0 ? <b>{state.approvals.length} 待确认</b> : running && <i className="tiny-dot green"/>}</button><div className="agent-floating" role="dialog" aria-modal="false" aria-label="Nexus Agent 悬浮窗" hidden={!agentOpen} style={{ left: position.x, top: position.y }} onKeyDown={e => { if (e.key === 'Escape') setAgentOpen(false); }}>
  <header className="agent-float-header"><div className="agent-drag-handle" role="button" tabIndex={0} aria-label="拖动 Agent 悬浮窗，也可用方向键移动" onPointerDown={e => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, left: position.x, top: position.y }; }} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onKeyDown={e => { const offset: Record<string, [number, number]> = { ArrowLeft: [-24, 0], ArrowRight: [24, 0], ArrowUp: [0, -24], ArrowDown: [0, 24] }; if (offset[e.key]) { e.preventDefault(); const [x, y] = offset[e.key]; setPosition(clamp(position.x + x, position.y + y)); } }}><span className="agent-avatar"><Bot size={20}/></span><div><strong>Nexus Agent</strong><small>{running ? '任务执行中' : '你的设备操作助手'}</small></div><GripHorizontal size={18}/></div><VoiceRecordingIndicator voice={voice}/><button className="icon-btn" aria-label="隐藏 Agent 悬浮窗" title="隐藏，任务会继续运行" onClick={() => setAgentOpen(false)}><Minus size={19}/></button></header>
  <div className="agent-device-toolbar"><select aria-label="选择 Agent 设备" value={target.id} onChange={e => chooseTarget(e.target.value)}>{targets.map(item => <option key={item.id} value={item.id}>{item.name} · {item.kind === 'pc' ? hostActivityLabel(state.host) + (item.agent ? '' : ' · 待授权') : activityLabel(item.device!)}</option>)}</select><select aria-label="选择模型方案" value={profileId} onChange={e => setProfileId(e.target.value)} disabled={running || busy}><option value="">选择模型方案</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}{profile.hasKey ? '' : ' · 未配置'}</option>)}</select><button className="text-btn" title="由本机 Agent 创建电话请求或会议邀请" onClick={() => { chooseTarget(`pc:${state.room.id}`); setTask(`给${state.devices.find(device => device.online)?.name ?? '设备型号'}打电话`); setDetails(false); }}>安排会议或通话</button><button className="text-btn" onClick={() => setDetails(!details)}>{details ? '返回对话' : `确认与历史${state.approvals.length ? ` (${state.approvals.length})` : ''}`}</button><button className="icon-btn" aria-label="模型设置" onClick={() => { setPage('settings'); setAgentOpen(false); }}><ChevronRight size={18}/></button></div>
  <div className="agent-mode-bar"><div role="group" aria-label="Agent 执行模式"><button aria-pressed={shownMode === 'request'} disabled={running || busy} onClick={() => chooseMode('request')}>请求模式</button><button aria-pressed={shownMode === 'automatic'} disabled={running || busy} onClick={() => chooseMode('automatic')}>自动模式</button></div><small>{running ? '执行模式已锁定，可随时停止任务' : mode === 'automatic' ? target.kind === 'pc' ? '按当前 Windows 用户权限连续执行' : '已授权操作连续执行，无需逐步批准' : '敏感操作需逐次确认'}</small></div>
  {target.kind === 'pc' && <div className="agent-workdir"><span>PC 工作目录</span><output aria-label="PC 工作目录" title={workspacePath || '默认：Windows 用户主目录'}>{workspacePath || 'Windows 用户主目录'}</output><button className="btn secondary" aria-label="选择 PC 工作目录" disabled={running || busy || !pcAgentEnabled} onClick={() => setWorkspaceOpen(true)}><FolderOpen size={15}/>选择文件夹</button>{workspacePath && <button className="icon-btn" aria-label="使用默认工作目录" disabled={running || busy} onClick={() => chooseWorkspace('')}><X size={15}/></button>}</div>}
  <VoiceSettings voice={voice} roomId={state.room.id} roomName={state.room.name} boundRoomName={state.rooms.find(item => item.id === voice.status?.roomId)?.name || '其他房间'} targetName={id => targets.find(item => item.id === id)?.name || '目标设备'} hasProfile={profiles.some(profile => profile.id === profileId && profile.hasKey)}/>
  {!!state.approvals.length && !details && <button className="agent-approval-banner" onClick={() => setDetails(true)}><ShieldCheck size={16}/>{state.approvals.length} 项操作等待确认<ChevronRight size={16}/></button>}
  <section className="agent-workspace" hidden={details}><div className="conversation">{run ? <><div className="user-message"><span>你 · {run.mode === 'automatic' ? '自动模式' : '请求模式'}</span><p>{run.task}</p></div>{run.events.map((e, i) => <div className={`agent-event ${e.kind}`} key={i}><div className="event-icon">{e.kind === 'tool' ? <Terminal size={14}/> : e.kind === 'error' ? <AlertCircle size={15}/> : e.kind === 'assistant' ? <Bot size={16}/> : <Check size={14}/>}</div><div><span className="event-label">{e.kind === 'tool' ? '设备工具' : e.kind === 'result' ? '执行结果' : e.kind === 'assistant' ? 'Nexus Agent' : '任务状态'}<time>{time(e.time)}</time></span><pre>{e.text}</pre></div></div>)}<div ref={end}/></> : <div className="agent-welcome"><div className="agent-mark"><Sparkles size={29} strokeWidth={1.5}/></div><h2>把下一步，交给 Agent。</h2><p>从打开设置，到整理文件。<br/>描述你想完成的事情，执行过程会在这里清晰呈现。</p><div className="suggestions">{(target.kind === 'pc' ? ['查看当前工作目录中的文件', '给房间里的手机打电话', '发起一个私密会议室，邀请房间里的手机在线设备加入'] : ['打开手机设置并查看当前 Wi-Fi', '将手机上最近的三张照片传到电脑', '列出已导入电脑、可以发送到手机的文件']).map(s => <button key={s} onClick={() => setTask(s)}>{s}<ArrowUp size={14}/></button>)}</div></div>}</div><div className="agent-compose"><div className="agent-voice-input"><VoiceMicrophone voice={voice}/><textarea aria-label="输入 Agent 任务" placeholder={`让 Agent 在 ${target.name} 上做点什么…`} value={task} onChange={e => setTask(e.target.value)} maxLength={8000} onKeyDown={e => { if (e.ctrlKey && e.key === 'Enter' && task.trim() && consent && !busy && !running && canStart) { e.preventDefault(); void start(); } }}/></div><div className="compose-footer"><span><ShieldCheck size={14}/> 仅操作已授权设备</span>{running ? <button className="btn secondary" onClick={() => { if (activeRun) void act(() => api(`/api/agent/runs/${activeRun.id}`, undefined, 'DELETE'), '已请求停止任务'); }}><Square size={13}/> 停止任务</button> : <button className="btn primary" disabled={!task.trim() || !canStart || !consent || busy} onClick={() => void start()}>执行任务 <ArrowUp size={17}/></button>}</div><label className="consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}/> 我同意将任务、工具结果和所需截图发送到已配置的模型服务。</label></div></section>
  <aside className="agent-sidebar" hidden={!details}><section className="panel"><h2>操作设备</h2><select aria-label="选择 Agent 设备" className="full" value={target.id} onChange={e => chooseTarget(e.target.value)}>{targets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><div className="agent-device">{target.kind === 'pc' ? <Monitor size={27}/> : <Smartphone size={27}/>}<div><strong>{target.name}</strong><Status online={target.online} label={target.kind === 'pc' ? hostActivityLabel(state.host) : activityLabel(target.device!)}/></div><span className={target.agent ? 'permission-on' : 'muted'}>{target.agent ? 'Agent 已授权' : '待授权'}</span></div></section>
  <section className="panel approval-panel"><h2><ShieldCheck size={18}/> 操作确认 <span className="count">{state.approvals.length}</span></h2>{state.approvals.length ? state.approvals.map(a => <div className="approval" key={a.id}><strong>{toolLabels[a.tool] ?? a.tool}</strong><small>{state.devices.find(d => d.id === a.deviceId)?.name ?? a.deviceId} · {time(a.expiresAt)} 前确认</small><pre>{JSON.stringify(a.arguments, null, 2)}</pre><div><button className="btn secondary" onClick={() => void act(() => api(`/api/approvals/${a.id}`, { allow: false }), '已拒绝操作')}><X size={14}/> 拒绝</button><button className="btn primary" onClick={() => void act(() => api(`/api/approvals/${a.id}`, { allow: true }), '已批准本次操作')}><Check size={14}/> 允许一次</button></div></div>) : <div className="approval-empty"><ShieldCheck size={25} strokeWidth={1.5}/><p>当前没有待确认操作</p><small>每次确认仅对显示的具体操作生效。</small></div>}</section>
  {targetRuns.length > 0 && <section className="panel"><h2><Clock3 size={17}/> 本次启动的任务</h2><div className="run-history">{targetRuns.map(r => <button key={r.id} className={run?.id === r.id ? 'active' : ''} onClick={() => { setCurrent(r.id); setDetails(false); }}><span>{r.task}</span><small>{r.mode === 'automatic' ? '自动模式' : '请求模式'} · {time(r.startedAt)}</small></button>)}</div></section>}<div className="privacy-note"><ShieldCheck size={21}/><div><strong>每一步都可以看见</strong><p>请求模式逐步批准，自动模式连续执行。任务可随时停止。</p></div></div></aside></div>{workspaceOpen && !running && !busy && <WorkspacePicker initialPath={workspacePath} close={() => setWorkspaceOpen(false)} choose={path => { chooseWorkspace(path); setWorkspaceOpen(false); }}/>}</>, portal);
}
