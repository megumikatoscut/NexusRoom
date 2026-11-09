import { useEffect, useRef, useState } from 'react';
import { KeyRound, ShieldCheck, Cable, Save, FlaskConical, Copy, RefreshCw, LockKeyhole, Plus, Trash2, Star } from 'lucide-react';
import { api } from '../api';
import { useRoom } from '../context';
import { Busy, Field } from '../components/UI';
import { pcRemotePermissionLabels } from '../components/PcRemoteNotice';
import type { AgentProfile, PcRemotePermissions, Settings as SettingsData } from '../types';

export function Settings() {
  const { state, act, notify } = useRoom();
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [key, setKey] = useState('');
  const [roomName, setRoomName] = useState(state?.room.name ?? '');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState('');
  const [profileId, setProfileId] = useState('');
  const [profileName, setProfileName] = useState('');
  const [profileDirty, setProfileDirty] = useState(false);
  const profileIdRef = useRef(profileId);
  const profileDirtyRef = useRef(profileDirty);
  profileIdRef.current = profileId;
  profileDirtyRef.current = profileDirty;

  useEffect(() => {
    let active = true;
    let failed = false;
    const refreshProfiles = () => api<SettingsData>('/api/settings').then(value => {
      if (!active) return;
      failed = false;
      const currentId = profileIdRef.current;
      if (!value.profiles.some(profile => profile.id === currentId)) {
        const nextId = value.defaultProfileId || value.profiles[0]?.id || '';
        profileIdRef.current = nextId;
        profileDirtyRef.current = false;
        setProfileId(nextId);
        setProfileDirty(false);
      }
      setSettings(previous => {
        const preserve = profileDirtyRef.current ? previous?.profiles.find(profile => profile.id === profileIdRef.current) : undefined;
        const profiles = value.profiles.map(profile => preserve?.id === profile.id ? preserve : profile);
        return previous ? { ...previous, defaultProfileId: value.defaultProfileId, pcAgentEnabled: value.pcAgentEnabled, pcRemotePermissions: value.pcRemotePermissions, profiles } : value;
      });
    }).catch(e => {
      if (active && !failed) notify(e.message, true);
      failed = true;
    });
    void refreshProfiles();
    const timer = window.setInterval(() => { void refreshProfiles(); }, 6000);
    return () => { active = false; window.clearInterval(timer); };
  }, [notify, state?.room.id]);

  const selectedProfile = settings?.profiles.find(profile => profile.id === profileId);
  useEffect(() => {
    if (selectedProfile) {
      setProfileName(selectedProfile.name);
      setKey('');
      setProfileDirty(false);
      profileDirtyRef.current = false;
    }
  }, [profileId, selectedProfile?.name]);

  const updateProfile = (update: Partial<AgentProfile>) => {
    if (!selectedProfile || !settings) return;
    setProfileDirty(true);
    profileDirtyRef.current = true;
    setSettings({ ...settings, profiles: settings.profiles.map(profile => profile.id === selectedProfile.id ? { ...profile, ...update } : profile) });
  };
  const reloadSettings = async () => {
    const next = await api<SettingsData>('/api/settings');
    setSettings(next);
    return next;
  };
  const save = async () => {
    if (!settings || !selectedProfile) return;
    setBusy('save');
    try {
      await act(async () => {
        await api('/api/settings', {
          apiUrl: selectedProfile.apiUrl, model: selectedProfile.model, apiType: selectedProfile.apiType,
          maxCalls: selectedProfile.maxCalls, maxSteps: selectedProfile.maxSteps, timeoutSeconds: selectedProfile.timeoutSeconds,
          profileId: selectedProfile.id, profileName, confirmMutations: settings.confirmMutations,
          pcAgentEnabled: settings.pcAgentEnabled, apiKey: key,
        });
        setKey('');
        setProfileDirty(false);
        profileDirtyRef.current = false;
        await reloadSettings();
      }, '模型方案已加密保存');
    } finally { setBusy(''); }
  };
  const createProfile = async () => {
    const name = profileName.trim();
    if (!name) { notify('请输入方案名称', true); return; }
    setBusy('profile');
    try {
      await act(async () => {
        const created = await api<AgentProfile>('/api/settings/profiles', { name, apiType: 'chat_completions', apiUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-sol', apiKey: '', maxCalls: 24, maxSteps: 24, timeoutSeconds: 900 });
        const next = await reloadSettings();
        setProfileId(next.profiles.some(profile => profile.id === created.id) ? created.id : next.defaultProfileId);
      }, '已新增房间模型方案');
    } finally { setBusy(''); }
  };
  const deleteProfile = async () => {
    if (!selectedProfile || !settings || settings.profiles.length <= 1) return;
    if (!window.confirm(`删除模型方案“${selectedProfile.name}”？此操作会同步到房间内所有设备。`)) return;
    setBusy('delete');
    try {
      await act(async () => {
        await api(`/api/settings/profiles/${encodeURIComponent(selectedProfile.id)}`, undefined, 'DELETE');
        const next = await reloadSettings();
        setProfileId(next.defaultProfileId || next.profiles[0]?.id || '');
      }, '模型方案已从房间删除');
    } finally { setBusy(''); }
  };
  const makeDefault = async () => {
    if (!selectedProfile || !settings || settings.defaultProfileId === selectedProfile.id) return;
    setBusy('default');
    try {
      await act(async () => {
        await api(`/api/settings/profiles/${encodeURIComponent(selectedProfile.id)}/default`, {});
        await reloadSettings();
      }, '默认模型方案已更新');
    } finally { setBusy(''); }
  };
  const changePcAgent = async (enabled: boolean) => {
    setBusy('pc');
    try {
      const saved = await act(() => api('/api/settings/pc-agent', { enabled }), enabled ? 'Windows Agent 已启用' : 'Windows Agent 已停用');
      if (saved) setSettings(previous => previous ? { ...previous, pcAgentEnabled: enabled } : previous);
    } finally { setBusy(''); }
  };
  const changePcRemote = async (permission: keyof PcRemotePermissions, enabled: boolean) => {
    const permissions = state?.host.remote?.permissions ?? settings?.pcRemotePermissions ?? { screen: false, control: false, audio: false, clipboard: false };
    const next = { ...permissions, [permission]: enabled };
    setBusy('remote');
    try {
      const saved = await act(() => api('/api/pc/remote/permissions', next), enabled ? '此房间的电脑远程权限已开启' : '此房间的电脑远程权限已撤销');
      if (saved) setSettings(previous => previous ? { ...previous, pcRemotePermissions: next } : previous);
    } finally { setBusy(''); }
  };

  if (!settings || !state) return null;
  return <>
    <div className="page-heading"><div><h1>设置</h1><p>配置你的工作空间、模型连接与安全偏好。</p></div></div>
    <div className="settings-layout"><div>
      <section className="panel settings-section" aria-label="Windows 远程访问权限">
        <div className="settings-heading"><span className="quick-icon"><ShieldCheck size={21}/></span><div><h2>手机远程访问这台电脑</h2><p>仅限当前房间已认证的手机。每次连接都需在电脑允许，权限更改立即生效。</p></div></div>
        {pcRemotePermissionLabels.map(([permission, label]) => <label className="setting-toggle" key={permission}><input type="checkbox" aria-label={`允许手机${label}`} checked={(state.host.remote?.permissions ?? settings.pcRemotePermissions)?.[permission] ?? false} disabled={!!busy} onChange={e => void changePcRemote(permission, e.target.checked)}/><div><strong>{label}</strong><p>{{ screen: '共享电脑桌面，包括窗口与通知；默认关闭。', control: '手机可点击、拖动、滚动及输入文字；关闭后仅能查看画面。', audio: '同步电脑正在播放的声音，不采集麦克风。', clipboard: '允许在电脑与手机之间传输剪贴板文本。' }[permission]}</p></div></label>)}
        <p className="fine-print">批准仅对当前会话生效，结束后再次连接需重新确认。撤销任一权限会立即结束共享；你也可在页面顶部直接停止。</p>
      </section>
      <section className="panel settings-section">
        <div className="settings-heading">
          <span className="quick-icon purple"><KeyRound size={21}/></span>
          <div><h2>房间模型方案</h2><p>当前房间共有 {settings.profiles.length} 个方案；更改会同步到 Android 与本房间的 Agent。</p></div>
          <span className="tag">{selectedProfile?.hasKey ? '已配置密钥' : '待配置'}</span>
        </div>
        <div className="form-columns">
          <Field label="当前方案"><select value={profileId} onChange={e => setProfileId(e.target.value)}>{settings.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}{settings.defaultProfileId === profile.id ? ' · 默认' : ''}</option>)}</select></Field>
          <Field label="方案名称"><input value={profileName} onChange={e => { setProfileName(e.target.value); setProfileDirty(true); profileDirtyRef.current = true; }} /></Field>
        </div>
        <Field label="API URL" hint="手机 Agent 需 HTTPS；支持服务根地址、/v1 地址或完整接口地址。"><input value={selectedProfile?.apiUrl ?? ''} onChange={e => updateProfile({ apiUrl: e.target.value })} placeholder="https://api.openai.com/v1"/></Field>
        <div className="form-columns">
          <Field label="API 类型"><select value={selectedProfile?.apiType ?? 'chat_completions'} onChange={e => updateProfile({ apiType: e.target.value as AgentProfile['apiType'] })}><option value="chat_completions">Chat Completions</option><option value="responses">Responses</option></select></Field>
          <Field label="Model"><input value={selectedProfile?.model ?? ''} onChange={e => updateProfile({ model: e.target.value })} placeholder="gpt-5.6-sol"/></Field>
        </div>
        <div className="form-columns">
          <Field label="API Key" hint="留空保留现有密钥。"><input type="password" autoComplete="new-password" value={key} onChange={e => { setKey(e.target.value); setProfileDirty(true); profileDirtyRef.current = true; }} placeholder={selectedProfile?.hasKey ? '已安全保存 · 输入以替换' : '输入模型服务密钥'}/></Field>
          <Field label="最多调用次数"><input type="number" min="1" max="200" value={selectedProfile?.maxCalls ?? 24} onChange={e => updateProfile({ maxCalls: Number(e.target.value) })}/></Field>
        </div>
        <div className="form-columns">
          <Field label="最多操作步数"><input type="number" min="1" max="100" value={selectedProfile?.maxSteps ?? 24} onChange={e => updateProfile({ maxSteps: Number(e.target.value) })}/></Field>
          <Field label="超时（秒）"><input type="number" min="30" max="3600" value={selectedProfile?.timeoutSeconds ?? 900} onChange={e => updateProfile({ timeoutSeconds: Number(e.target.value) })}/></Field>
        </div>
        <label className="setting-toggle"><input type="checkbox" checked={settings.confirmMutations} onChange={e => setSettings({ ...settings, confirmMutations: e.target.checked })}/><div><strong>外部 Agent API 的 Android 操作需确认</strong><p>手机本地 Agent 按任务选择的请求模式或自动模式执行。</p></div></label>
        <div className="settings-actions">
          <button className="btn primary" disabled={!!busy || !selectedProfile} onClick={() => void save()}>{busy === 'save' ? <Busy/> : <><Save size={16}/> 保存当前方案</>}</button>
          <button className="btn secondary" disabled={!!busy || !selectedProfile || (!selectedProfile.hasKey && !key)} onClick={async () => { if (!selectedProfile) return; setBusy('test'); try { await act(async () => { const result = await api<{ reply: string }>('/api/settings/test', { profileId: selectedProfile.id, name: profileName, apiType: selectedProfile.apiType, apiUrl: selectedProfile.apiUrl, model: selectedProfile.model, apiKey: key, maxCalls: selectedProfile.maxCalls, maxSteps: selectedProfile.maxSteps, timeoutSeconds: selectedProfile.timeoutSeconds }); notify(`连接成功：${result.reply}`); }); } finally { setBusy(''); } }}>{busy === 'test' ? <Busy text="测试连接中…"/> : <><FlaskConical size={16}/> 测试方案</>}</button>
          <button className="btn secondary" disabled={!!busy} onClick={() => void createProfile()}><Plus size={16}/> 新增方案</button>
          <button className="btn secondary" disabled={!!busy || !selectedProfile || settings.defaultProfileId === selectedProfile.id} onClick={() => void makeDefault()}><Star size={16}/> 设为默认</button>
          <button className="btn secondary" disabled={!!busy || settings.profiles.length <= 1} onClick={() => void deleteProfile()}><Trash2 size={16}/> 删除方案</button>
          {settings.defaultProfileId === selectedProfile?.id && <span className="muted">当前为房间默认方案</span>}
        </div>
      </section>
      <section className="panel settings-section">
        <h2>此房间的 Windows Agent</h2>
        <label className="setting-toggle"><input type="checkbox" checked={settings.pcAgentEnabled} disabled={!!busy} onChange={e => void changePcAgent(e.target.checked)}/><div><strong>允许房间 Agent 操作这台电脑</strong><p>默认开启，切换后立即生效。手机也可提交 PC 任务；停用会停止当前 PC 任务。</p></div></label>
        <p>自动模式按当前 Windows 用户权限执行。请求模式的敏感操作需要逐次确认；任务的工作目录可在 Agent 页面指定。</p>
      </section>
      <section className="panel settings-section">
        <h2>外部 Agent API 的文件夹授权</h2>
        <p>以下目录仅供外部 API 读取电脑文件，不限制 Windows Agent 的本机文件操作。</p>
        {settings.sharedFolders.map(folder => <div className="shared-folder" key={folder.id}><div><strong>{folder.name}</strong><code>{folder.path}</code></div><button className="text-btn danger" onClick={() => void act(async () => { await api(`/api/settings/folders/${folder.id}`, undefined, 'DELETE'); setSettings(await api<SettingsData>('/api/settings')); }, '目录授权已撤销')}>撤销</button></div>)}
        <button className="btn secondary" disabled={!!busy} onClick={() => { setBusy('folder'); void act(async () => { await api('/api/settings/folders', {}); setSettings(await api<SettingsData>('/api/settings')); }).finally(() => setBusy('')); }}>{busy === 'folder' ? <Busy text="请在系统窗口选择文件夹…"/> : '添加授权文件夹'}</button>
      </section>
      <section className="panel settings-section">
        <div className="settings-heading"><span className="quick-icon"><Cable size={21}/></span><div><h2>Agent API</h2><p>让外部程序安全调用房间设备工具。</p></div></div>
        <Field label="本机 API 地址"><input readOnly value={`${location.origin}/agent/v1`}/></Field>
        <div className="api-example"><code>GET /devices<br/>GET /tools<br/>POST /devices/&#123;id&#125;/actions</code><span>Authorization: Bearer &lt;token&gt;</span></div>
        {token && <div className="token-box"><p>新令牌仅在此显示一次，请安全保存。</p><code>{token}</code><button className="text-btn" onClick={() => void navigator.clipboard.writeText(token).then(() => notify('API 令牌已复制')).catch(() => notify('请手动复制', true))}><Copy size={14}/> 复制令牌</button></div>}
        <div className="settings-actions"><button className="btn secondary" onClick={() => void act(async () => { const result = await api<{ token: string }>('/api/settings/token', {}); setToken(result.token); setSettings({ ...settings, hasExternalToken: true }); }, '已生成新令牌，旧令牌立即失效')}><RefreshCw size={16}/>{settings.hasExternalToken ? '轮换 API 令牌' : '生成 API 令牌'}</button>{settings.hasExternalToken && <button className="text-btn danger" onClick={() => void act(async () => { await api('/api/settings/token', undefined, 'DELETE'); setToken(''); setSettings({ ...settings, hasExternalToken: false }); }, '外部 API 已关闭')}>撤销外部访问</button>}</div>
      </section>
      <section className="panel settings-section">
        <div className="settings-heading"><span className="quick-icon"><Cable size={21}/></span><div><h2>房间偏好</h2><p>房间信息只在你的本机保存。</p></div></div>
        <Field label="房间名称"><input maxLength={60} value={roomName} onChange={e => setRoomName(e.target.value)}/></Field>
        <button className="btn secondary" disabled={!roomName.trim()} onClick={() => void act(() => api('/api/room', { name: roomName }), '房间名称已保存')}>保存房间名称</button>
      </section>
    </div>
    <aside>
      <section className="panel"><h2><ShieldCheck size={18}/> 安全设计</h2><ul className="security-list"><li>控制台仅在这台 Windows 上可用</li><li>Android 通道使用 TLS 和证书固定</li><li>房间密码与独立设备令牌验证</li><li>两端分别授权，可随时撤销</li><li>手机访问电脑需本机逐次允许</li><li>Android 工具使用固定允许列表</li><li>Windows Agent 可随时停用或停止任务</li><li>日志不记录密钥和剪贴板正文</li></ul></section>
      <div className="privacy-note"><LockKeyhole size={22}/><div><strong>模型服务的数据边界</strong><p>运行任务时，所需截图、控件文本和工具结果会发送到你配置的模型服务。请使用你信任的服务。</p></div></div>
      <section className="panel"><h2>附近房间发现</h2><p>自动发现使用局域网广播和 mDNS。需要允许本应用通过 Windows 防火墙。</p><button className="btn secondary" onClick={() => void act(() => api('/api/network/firewall', {}), '请完成 Windows 管理员确认，然后在手机重新搜索')}>配置局域网访问</button><p className="fine-print">访客 Wi-Fi、AP 隔离或 VPN 可能阻止设备互访，可使用普通家庭 Wi-Fi 或扫码填写直连地址。</p></section>
      <section className="panel storage-panel"><h2>本地存储</h2><code>{settings.dataDirectory}</code><p>文件库上限 10 GB，单文件 512 MB。密钥仅限当前 Windows 用户解密。</p></section>
    </aside></div>
  </>;
}
