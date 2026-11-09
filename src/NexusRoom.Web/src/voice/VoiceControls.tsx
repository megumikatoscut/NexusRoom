import { LoaderCircle, Mic, Radio } from 'lucide-react';
import type { useVoice } from './useVoice';
type Voice = ReturnType<typeof useVoice>;
export function VoiceRecordingIndicator({ voice }: { voice: Voice }) {
  return voice.recording ? <span className="voice-recording-indicator" role="status" aria-label="本机正在录音"><i aria-hidden="true"/><span>录音中</span></span> : null;
}
const phaseLabels: Record<string, string> = {
  disabled: '语音已关闭', idle: '语音就绪', ready: '语音就绪', listening: '等待 Hi Nexus',
  waking: '已唤醒', arbitrating: '正在确认房间唤醒', recording: '正在录音',
  'recording-manual': '正在录音，松开完成转写', 'recording-wake': '已唤醒，正在录音',
  transcribing: '本地转写中', loading: '模型加载中',
  initializing: '模型加载中', starting: '启动麦克风中', error: '语音暂不可用', stopped: '监听已停止',
};
const taskLabels: Record<string, string> = { collecting: '等待转写', pending: '选择设备中', routing: '选择设备中', selecting: '选择设备中', dispatching: '提交任务中', started: '任务已启动', submitted: '任务已提交', running: '任务执行中', executing: '任务执行中', completed: '任务完成', duplicate: '已合并重复唤醒', ignored: '已忽略', failed: '任务失败', cancelled: '已取消', interrupted: '任务因主机重启中断', error: '语音指令失败' };
export function VoiceSettings({ voice, roomId, roomName, boundRoomName, targetName, hasProfile }: { voice: Voice; roomId: string; roomName: string; boundRoomName: string; targetName: (id: string) => string; hasProfile: boolean }) {
  const { status, saving, error, capturePhase, tasks } = voice;
  const boundElsewhere = status?.enabled && status.roomId && status.roomId !== roomId;
  const latest = tasks[0];
  const phase = capturePhase || status?.phase || 'disabled';
  return <div className="agent-voice-settings">
    <div className="voice-switches"><label><input type="checkbox" checked={!!status?.enabled} disabled={!status || saving} onChange={e => void voice.configure(e.target.checked, false)}/><Mic size={14}/>本地语音</label>
      <label title="说 Hi Nexus 后自动选择设备并执行；任务文本发送至所选房间模型服务"><input type="checkbox" checked={!!status?.wakeEnabled && !boundElsewhere} disabled={!status?.enabled || saving || !hasProfile} onChange={e => void voice.configure(true, e.target.checked)}/><Radio size={14}/>Hi Nexus · 自动执行</label></div>
    <small role="status" aria-live="polite">{saving ? '保存语音设置…' : boundElsewhere ? `正在监听 ${boundRoomName}；启用本房间唤醒可切换` : `${phaseLabels[phase] || phase} · ${roomName}`}</small>
    {!hasProfile && status?.enabled && <small>自动唤醒需选择已配置 Key 的房间模型方案</small>}
    {(error || status?.error) && <small className="voice-error" role="alert">{error || status?.error}</small>}
    {latest && <small className={latest.error ? 'voice-error' : ''} title={latest.taskId}>{latest.text || '语音指令'} · {latest.error || taskLabels[latest.status] || latest.status}{latest.targetId ? ` · ${targetName(latest.targetId)}` : ''}</small>}
  </div>;
}
export function VoiceMicrophone({ voice }: { voice: Voice }) {
  const { status, capturePhase, saving } = voice;
  const pending = capturePhase === 'starting' || capturePhase === 'transcribing';
  const recording = capturePhase === 'recording';
  const disabled = !status?.enabled || !status.ready || saving || capturePhase === 'transcribing';
  return <button type="button" className={`voice-microphone ${recording ? 'recording' : ''}`} disabled={disabled}
    aria-label={recording ? '松开麦克风完成本地转写' : '按住麦克风进行本地语音输入'} aria-pressed={recording}
    title={!status?.enabled ? '先开启本地语音' : '按住说话，松开填入输入框；也可按住空格键'}
    onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); void voice.press(); }}
    onPointerUp={e => { e.preventDefault(); voice.release(); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
    onPointerCancel={() => voice.cancel()} onLostPointerCapture={() => { if (capturePhase !== 'transcribing') voice.release(); }}
    onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!e.repeat) void voice.press(); } else if (e.key === 'Escape') voice.cancel(); }}
    onKeyUp={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); voice.release(); } }} onBlur={() => { if (capturePhase !== 'transcribing') voice.cancel(); }}
    onContextMenu={e => e.preventDefault()}>{pending ? <LoaderCircle size={19} className="voice-spinner"/> : <Mic size={20}/>}<small>{recording ? '松开' : pending ? '转写' : '按住'}</small></button>;
}
