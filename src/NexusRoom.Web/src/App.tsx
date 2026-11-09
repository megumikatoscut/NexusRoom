import { LayoutDashboard, Smartphone, FolderSync, Bot, ScrollText, Settings as SettingsIcon, Network, ChevronRight, Wifi, ShieldCheck, AlertCircle, CheckCircle2, Phone } from 'lucide-react';
import { useRoom } from './context';
import { Overview } from './features/Overview';
import { Devices } from './features/Devices';
import { Files } from './features/Files';
import { Agent } from './features/Agent';
import { Logs } from './features/Logs';
import { Settings } from './features/Settings';
import { Invitation } from './components/Invitation';
import { Rooms } from './components/Rooms';
import { PcRemoteNotice } from './components/PcRemoteNotice';
import { Communication, CommunicationNotice } from './features/Communication';
import type { Page } from './types';

declare const __NEXUSROOM_VERSION__: string;

const navigation = [{ id: 'overview', label: '房间总览', icon: LayoutDashboard }, { id: 'devices', label: '设备控制', icon: Smartphone }, { id: 'files', label: '文件传输', icon: FolderSync }, { id: 'communication', label: '通话与会议', icon: Phone }, { id: 'agent', label: 'Agent 控制台', icon: Bot }, { id: 'logs', label: '操作日志', icon: ScrollText }, { id: 'settings', label: '设置', icon: SettingsIcon }] as const;
const screens: Record<Page, () => React.JSX.Element | null> = { overview: Overview, devices: Devices, files: Files, communication: Communication, agent: Overview, logs: Logs, settings: Settings };
export default function App() {
  const { state, error, page, setPage, toast, invite } = useRoom(); const Screen = screens[page]; const currentLabel = page === 'agent' ? '房间总览' : navigation.find(n => n.id === page)?.label;
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><span className="brand-mark"><Network size={23}/></span><strong>NexusRoom<span>DEVICE WORKSPACE</span></strong></div><Rooms/><div className="workspace-label">工作空间</div><nav aria-label="主导航">{navigation.map(n => <button key={n.id} aria-label={n.label} title={n.label} className={(n.id === 'agent' ? false : page === n.id) ? 'active' : ''} onClick={() => setPage(n.id)}><n.icon size={19} strokeWidth={1.75}/><span>{n.label}</span>{n.id === 'agent' && !!state?.approvals.length && <b>{state.approvals.length}</b>}{n.id !== 'agent' && page === n.id && <span className="nav-active-dot"/>}</button>)}</nav><div className="sidebar-bottom"><div className="local-only"><span><Wifi size={18}/></span><div><strong>局域网工作空间</strong><p>连接留在你的网络里</p></div></div><div className="sidebar-footer"><span className="host-avatar">W</span><div><strong>{state?.host.name ?? 'Windows 主控制端'}</strong><small><i/> 本地服务器</small></div><ShieldCheck size={16}/></div><small className="app-version">NexusRoom v{__NEXUSROOM_VERSION__}</small></div></aside><div className="main-shell"><header className="topbar"><div>工作空间 <ChevronRight size={14}/><strong>{currentLabel}</strong></div><span className={`connection-badge ${error ? 'warning' : ''}`}><i/>{error ? '连接需要检查' : '本地服务运行中'}</span></header><PcRemoteNotice/><CommunicationNotice/><main>{error && <div className="callout error" role="alert"><AlertCircle size={18}/>{error}</div>}{state ? state.room.id ? <Screen key={`${state.room.id}:${page}`}/> : <div className="empty"><Network size={48}/><h2>创建你的第一个房间</h2><p>点击左侧「新建房间」，邀请设备开始协作。</p></div> : !error && <div className="loading-state"><span className="loading-ring"/>正在连接本地工作空间…</div>}</main>{state && <footer className="workspace-footer"><span><ShieldCheck size={13}/> 安全连接 · 仅限已授权设备</span><span>Windows ↔ Android</span></footer>}</div>{state && <Agent/>}{toast && <div className={`toast ${toast.error ? 'error' : ''}`} role="status">{toast.error ? <AlertCircle size={19}/> : <CheckCircle2 size={19}/>}<span>{toast.text}</span></div>}{invite && <Invitation/>}</div>;
}
