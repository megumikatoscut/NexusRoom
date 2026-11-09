import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useRoom } from '../context';
import { api } from '../api';
import { Modal, Field, Busy } from './UI';

export function Rooms() {
 const {state,switchRoom,act}=useRoom();
 const [create,setCreate]=useState(false),[remove,setRemove]=useState(false),[name,setName]=useState(''),[busy,setBusy]=useState(false);
 return <div className="room-switcher"><label htmlFor="room-picker">当前房间</label><select id="room-picker" value={state?.room.id || ''} onChange={e=>void switchRoom(e.target.value)}>{!state?.rooms.length&&<option value="">创建你的工作空间</option>}{state?.rooms.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select><div><button className="text-btn" onClick={()=>setCreate(true)}><Plus size={14}/>新建房间</button><button className="icon-btn" aria-label="解散当前房间" disabled={!state?.room.id} onClick={()=>setRemove(true)}><Trash2 size={14}/></button></div>
 {create&&<Modal title="创建新房间" close={()=>setCreate(false)}><p className="modal-description">每个房间有独立邀请、设备和 Agent 配置。同一手机可以加入多个房间。</p><form onSubmit={e=>{e.preventDefault();setBusy(true);void act(async()=>{const r=await api<{id:string}>('/api/rooms',{name});await switchRoom(r.id);setCreate(false);setName('');},'房间已创建').finally(()=>setBusy(false));}}><Field label="房间名称"><input autoFocus value={name} onChange={e=>setName(e.target.value)} maxLength={60} placeholder="例如：书房 · 我的设备"/></Field><button className="btn primary" disabled={busy||!name.trim()}>{busy?<Busy/>:'创建房间'}</button></form></Modal>}
 {remove&&state&&<Modal title={`解散「${state.room.name}」？`} close={()=>setRemove(false)}><p className="modal-description">所有成员将失去此房间的访问权限，当前控制和任务将停止。离线手机下次连接时会同步移除。此房间的文件库副本将移至本机数据目录的 removed-rooms 归档，原始文件和手机下载文件保留。其他房间不受影响。</p><div className="modal-actions"><button className="btn secondary" onClick={()=>setRemove(false)}>取消</button><button className="btn destructive" disabled={busy} onClick={()=>{setBusy(true);void act(async()=>{await api(`/api/rooms/${state.room.id}`,undefined,'DELETE');setRemove(false);await switchRoom('');},'房间已解散').finally(()=>setBusy(false));}}>解散房间</button></div></Modal>}
 </div>;
}
