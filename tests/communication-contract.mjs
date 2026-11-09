import { projectPath } from '../scripts/submission-paths.mjs';
import assert from 'node:assert/strict'
import {spawn,execFileSync} from 'node:child_process'
import {once} from 'node:events'
import {createHash} from 'node:crypto'
import {mkdtemp,mkdir,copyFile,writeFile,readFile} from 'node:fs/promises'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import https from 'node:https'
import WebSocket from 'ws'
import {captureReleaseEvidence,assertReleaseEvidenceUnchanged} from './release-evidence.mjs'

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const release=JSON.parse(await readFile(projectPath(root,'release.json'),'utf8'))
const uiPort=Number(process.env.NEXUS_COMMUNICATION_UI_PORT||19490), devicePort=uiPort+1
await mkdir(projectPath(root,'.local'),{recursive:true})
const data=await mkdtemp(projectPath(root,'.local/communication-contract-'))
const hostExecutable=process.env.NEXUS_TEST_HOST_EXE,hostDll=process.env.NEXUS_TEST_HOST_DLL||projectPath(root,'src/NexusRoom.Host/bin/Debug/net10.0-windows/NexusRoom.Host.dll')
const artifacts=await captureReleaseEvidence({hostExecutable,hostDll:hostExecutable?undefined:hostDll,apk:process.env.NEXUS_TEST_APK,runtimePackage:process.env.NEXUS_TEST_RUNTIME_PACKAGE})
const runtime=resolve(data,'runtime'), workspace=resolve(data,'workspace')
await mkdir(resolve(runtime,'apps/cli/lib'),{recursive:true});await mkdir(workspace,{recursive:true})
await copyFile(projectPath(root,'tests/fixtures/room-files-runtime.mjs'),resolve(runtime,'apps/cli/lib/bin.js'))
const base='http://127.0.0.1:'+uiPort
const host=spawn(hostExecutable||'dotnet',hostExecutable?['--headless']:[hostDll,'--headless'],{
  cwd:root,windowsHide:true,env:{...process.env,NEXUS_DATA_DIR:data,NEXUS_UI_PORT:String(uiPort),NEXUS_DEVICE_PORT:String(devicePort),
    NEXUS_DISCOVERY_PORT:String(uiPort+2),NEXUS_DISABLE_MDNS:'1',NEXUS_HARNESS_DIR:runtime},stdio:['ignore','ignore','pipe']})
let diagnostic='';host.stderr.on('data',chunk=>diagnostic+=chunk.toString())
const sockets=[], phones=[]
let token='',fingerprint='',roomId='',count=0
const results=[]
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(predicate,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){const value=await predicate();if(value)return value;await delay(40)}throw new Error('Communication check timed out')}
async function request(path,body,room=roomId,method=body===undefined?'GET':'POST'){
  const response=await fetch(base+path,{method,headers:{Authorization:'Bearer '+token,'X-Nexus-Request':'1','X-Nexus-Room':room,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)})
  return {status:response.status,value:await response.json()}
}
async function api(path,body,room,method){const answer=await request(path,body,room,method);assert.equal(answer.status,200,JSON.stringify(answer.value));return answer.value}
function mobile(path,body,credential=''){
  return new Promise((resolve,reject)=>{const req=https.request('https://127.0.0.1:'+devicePort+path,{rejectUnauthorized:false,
    method:body===undefined?'GET':'POST',agent:false,headers:{Authorization:'Bearer '+credential,'Content-Type':'application/json'}},response=>{
      if(createHash('sha256').update(response.socket.getPeerCertificate().raw).digest('hex')!==fingerprint){response.destroy();reject(new Error('Certificate pin mismatch'));return}
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{try{resolve({status:response.statusCode,value:JSON.parse(Buffer.concat(chunks).toString())})}catch(error){reject(error)}})
    });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body))})
}
const comm=(phone,path,body)=>mobile('/device/communication'+path,body,phone.token)
async function ok(phone,path,body){const answer=await comm(phone,path,body);assert.equal(answer.status,200,JSON.stringify(answer.value));return answer.value}
async function connectCommunication(member,room=roomId){
  const pc=member===null
  const socket=new WebSocket(pc?'ws://127.0.0.1:'+uiPort+'/api/communication/ws?roomId='+room:'wss://127.0.0.1:'+devicePort+'/device/communication/ws',{
    rejectUnauthorized:false,headers:{Authorization:'Bearer '+(pc?token:member.token)}})
  sockets.push(socket);const messages=[];socket.on('message',raw=>messages.push(JSON.parse(raw.toString())));socket.on('error',()=>{})
  await once(socket,'open');if(!pc)assert.equal(createHash('sha256').update(socket._socket.getPeerCertificate().raw).digest('hex'),fingerprint)
  const ticker=setInterval(()=>{if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'ping'}))},10000);socket.on('close',()=>clearInterval(ticker))
  const connection={socket,messages};await until(()=>messages.find(m=>m.type==='state'));return connection
}
async function join(name,{room=roomId,physicalId=name,model=name}={}){
  const invitation=await api('/api/invitation',undefined,room)
  const answer=await mobile('/device/join',{roomId:room,password:invitation.password,name,model,version:'contract-v'+release.version,physicalId})
  assert.equal(answer.status,200,JSON.stringify(answer.value));const phone={...answer.value,commands:[],agentTask:''};phones.push(phone)
  const socket=new WebSocket('wss://127.0.0.1:'+devicePort+'/device/ws',{rejectUnauthorized:false,headers:{Authorization:'Bearer '+phone.token}})
  sockets.push(socket);phone.hub=socket;socket.on('error',()=>{})
  socket.on('message',raw=>{const message=JSON.parse(raw.toString());if(message.type!=='command')return;phone.commands.push(message)
    if(message.tool==='agent_start')phone.agentTask=message.arguments.taskId
    socket.send(JSON.stringify({type:'result',id:message.id,result:message.tool==='agent_start'?{accepted:true}:{ok:true}}))
  })
  await once(socket,'open');assert.equal(createHash('sha256').update(socket._socket.getPeerCertificate().raw).digest('hex'),fingerprint)
  const hello=()=>{if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'heartbeat',model,permissions:{agent:true,files:true}}))};hello()
  const ticker=setInterval(hello,10000);socket.on('close',()=>clearInterval(ticker))
  await until(async()=>(await api('/api/state',undefined,room)).devices.some(d=>d.id===phone.deviceId&&d.online&&d.permissions.agent))
  phone.connection=await connectCommunication(phone,room);return phone
}
async function check(name,action){try{await action();count++;results.push({name,passed:true});console.log('PASS '+name)}catch(error){results.push({name,passed:false,error:error.message});throw error}}
const session=id=>'/sessions/'+id
const signal=(connection,id,targetId,extra={})=>connection.socket.send(JSON.stringify({type:'signal',sessionId:id,targetId,signal:{type:'offer',sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n'},...extra}))
let pc,otherPc,a,b,observer,otherRoom,other,timerA,timerB,timedCall,expiringInvite
try{
  await until(async()=>{try{return(await fetch(base+'/health')).ok}catch{return false}})
  const safe=resolve(data,'launch.dat').replaceAll("'","''")
  const script="Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes('"+safe+"'),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))"
  const launch=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true}).trim());token=new URL(launch).hash.split('=')[1]
  const state=await api('/api/state');roomId=state.room.id;fingerprint=state.host.fingerprint
  assert.equal((await api('/health')).version,release.version)
  pc=await connectCommunication(null);a=await join('电话甲',{physicalId:'shared-physical',model:'测试型号A'});b=await join('电话乙',{model:'测试型号B'});observer=await join('旁观设备')
  otherRoom=await api('/api/rooms',{name:'第二通信房间'});otherPc=await connectCommunication(null,otherRoom.id);other=await join('甲的另一房间',{room:otherRoom.id,physicalId:'shared-physical'})
  timerA=await join('超时主叫');timerB=await join('超时被叫');timedCall=(await ok(timerA,'/calls',{targetId:timerB.deviceId})).session
  // Start real deadlines now, while the rest of the protocol and bridge suite runs.
  const expiringMeeting=(await ok(observer,'/meetings',{title:'邀请有效期',visibility:'private',inviteeIds:[b.deviceId]})).session
  expiringInvite=(await ok(b,'/state')).invitations.find(i=>i.sessionId===expiringMeeting.id)
  assert.equal(Date.parse(expiringInvite.expiresAt)-Date.parse(expiringInvite.createdAt),120000)
  await check('TLS-pinned room members and PC are listed by exact ID, name, and model',async()=>{
    const state=await ok(a,'/state');assert.equal(state.selfId,a.deviceId);assert.ok(state.devices.some(d=>d.id==='pc:'+roomId&&d.communicationOnline))
    assert.equal(state.devices.find(d=>d.id===a.deviceId).model,'测试型号A');assert.ok(!state.devices.some(d=>d.id===other.deviceId))
    const unauthenticated=await mobile('/device/communication/state');assert.equal(unauthenticated.status,401)
  })
  await check('call requests require acceptance, reserve both physical devices, and reject caller spoofing',async()=>{
    const created=(await ok(a,'/calls',{targetId:'测试型号B'})).session;assert.equal(created.status,'ringing');assert.equal(created.callerId,a.deviceId);assert.equal(created.calleeId,b.deviceId)
    assert.ok((await ok(b,'/state')).sessions.some(s=>s.id===created.id&&s.status==='ringing'))
    assert.ok(!(await ok(observer,'/state')).sessions.some(s=>s.id===created.id))
    assert.equal((await comm(a,'/calls',{targetId:b.deviceId,callerId:'fake'})).status,400)
    assert.equal((await comm(other,'/calls',{targetId:'pc:'+otherRoom.id})).status,409)
    assert.equal((await comm(a,'/calls/'+created.id+'/decision',{accept:true})).status,403)
    const before=b.connection.messages.filter(m=>m.type==='signal').length;signal(a.connection,created.id,b.deviceId)
    await until(()=>a.connection.messages.find(m=>m.type==='error'&&m.status===409));assert.equal(b.connection.messages.filter(m=>m.type==='signal').length,before)
    assert.equal((await ok(b,'/calls/'+created.id+'/decision',{accept:false})).session.endReason,'declined')
  })
  await check('active audio calls permit only joined-peer signaling and microphone state',async()=>{
    const call=(await ok(a,'/calls',{targetId:b.deviceId})).session;const accepted=(await ok(b,'/calls/'+call.id+'/decision',{accept:true})).session
    assert.equal(accepted.status,'active');assert.equal(accepted.participants.length,2);assert.ok(accepted.participants.every(p=>!p.microphone&&!p.camera&&!p.screen))
    await ok(a,session(call.id)+'/media',{microphone:true,camera:false,screen:false})
    assert.equal((await comm(a,session(call.id)+'/media',{microphone:false,camera:false,screen:false,screenAudio:true})).status,400)
    assert.equal((await comm(a,session(call.id)+'/media',{microphone:false,camera:true,screen:false})).status,400)
    signal(a.connection,call.id,b.deviceId);const forwarded=await until(()=>b.connection.messages.find(m=>m.type==='signal'&&m.sessionId===call.id));assert.equal(forwarded.fromId,a.deviceId)
    const received=b.connection.messages.filter(m=>m.type==='signal').length
    signal(a.connection,call.id,b.deviceId,{fromId:observer.deviceId});await until(()=>a.connection.messages.some(m=>m.type==='error'&&m.status===400))
    assert.equal(b.connection.messages.filter(m=>m.type==='signal').length,received)
    const crossSignals=other.connection.messages.filter(m=>m.type==='signal').length;signal(a.connection,call.id,other.deviceId);await delay(100);assert.equal(other.connection.messages.filter(m=>m.type==='signal').length,crossSignals)
    const videos=b.connection.messages.filter(m=>m.type==='signal').length
    a.connection.socket.send(JSON.stringify({type:'signal',sessionId:call.id,targetId:b.deviceId,signal:{type:'offer',sdp:'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendrecv\r\n'}}));await delay(100)
    assert.equal(b.connection.messages.filter(m=>m.type==='signal').length,videos)
    await ok(a,session(call.id)+'/leave',{});assert.equal((await ok(b,'/state')).activeSessionId,'')
  })
  await check('private meetings hide metadata/chat and require the invitation owner to accept',async()=>{
    const meeting=(await api('/api/communication/meetings',{title:'隐藏会议',visibility:'private',inviteeIds:[a.deviceId]})).session
    const invite=(await ok(a,'/state')).invitations.find(i=>i.sessionId===meeting.id);assert.ok(invite)
    assert.ok(!(await ok(a,'/state')).sessions.some(s=>s.id===meeting.id));assert.ok(!(await ok(b,'/state')).invitations.some(i=>i.sessionId===meeting.id))
    assert.equal((await comm(a,'/meetings/'+meeting.id+'/join',{})).status,404)
    assert.equal((await comm(b,'/invitations/'+invite.id+'/decision',{accept:true})).status,404)
    const joined=(await ok(a,'/invitations/'+invite.id+'/decision',{accept:true})).session;assert.equal(joined.participants.length,2)
    await ok(a,session(meeting.id)+'/chat',{text:'私密会中文字'})
    assert.ok(!(await ok(b,'/state')).sessions.some(s=>s.id===meeting.id));assert.ok(!(await ok(observer,'/state')).sessions.some(s=>s.id===meeting.id))
    assert.equal((await comm(a,session(meeting.id)+'/end',{})).status,403)
    assert.equal((await comm(a,'/meetings/'+meeting.id+'/invite',{deviceIds:[b.deviceId]})).status,403)
    await api('/api/communication/meetings/'+meeting.id+'/remove',{deviceId:a.deviceId})
    assert.equal((await ok(a,'/state')).activeSessionId,'');assert.equal((await comm(a,'/meetings/'+meeting.id+'/join',{})).status,403)
    await api('/api/communication/meetings/'+meeting.id+'/invite',{deviceIds:[a.deviceId]})
    const again=(await ok(a,'/state')).invitations.find(i=>i.sessionId===meeting.id);await ok(a,'/invitations/'+again.id+'/decision',{accept:true})
    await ok(a,session(meeting.id)+'/leave',{});assert.equal((await comm(a,'/meetings/'+meeting.id+'/join',{})).status,403)
    await api('/api/communication/sessions/'+meeting.id+'/end',{})
  })
  await check('public meetings allow free joining, member-only chat, and one physical PC across rooms',async()=>{
    const meeting=(await api('/api/communication/meetings',{title:'公开会议',visibility:'public',inviteeIds:[]})).session
    assert.equal((await api('/api/communication/camera/capability')).supported,false,'Headless API must not expose native camera access')
    assert.equal((await request('/api/communication/sessions/'+meeting.id+'/camera/ws')).status,403,'An external client acquired the native camera')
    assert.equal((await request('/api/communication/sessions/'+meeting.id+'/camera/ws',undefined,otherRoom.id)).status,404,'A different room could access the camera session')
    assert.ok((await ok(a,'/state')).sessions.some(s=>s.id===meeting.id));assert.equal((await request('/api/communication/meetings',{title:'另一电脑会议',visibility:'public'},otherRoom.id)).status,409)
    assert.equal((await comm(b,session(meeting.id)+'/chat',{text:'未加入'})).status,403)
    await ok(a,'/meetings/'+meeting.id+'/join',{});await ok(a,session(meeting.id)+'/chat',{text:'你好，公开会议'})
    assert.equal((await ok(b,'/state')).sessions.find(s=>s.id===meeting.id).messages.length,0)
    await ok(b,'/meetings/'+meeting.id+'/join',{});assert.equal((await ok(b,'/state')).sessions.find(s=>s.id===meeting.id).messages.at(-1).text,'你好，公开会议')
    await ok(a,session(meeting.id)+'/media',{microphone:true,camera:true,screen:true})
    assert.ok((await ok(b,'/state')).sessions.find(s=>s.id===meeting.id).participants.find(p=>p.deviceId===a.deviceId).screen)
    await ok(a,session(meeting.id)+'/leave',{});await ok(a,'/meetings/'+meeting.id+'/join',{})
    await api('/api/communication/sessions/'+meeting.id+'/leave',{})
    assert.equal((await ok(a,'/state')).sessions.find(s=>s.id===meeting.id).endReason,'host_left')
  })
  await check('screen audio is explicit, screen-bound, typed, and cleared when the meeting ends; ICE permits slots 3 and 4 only',async()=>{
    const meeting=(await api('/api/communication/meetings',{title:'共享声音协议',visibility:'public',inviteeIds:[]})).session
    await ok(a,'/meetings/'+meeting.id+'/join',{})
    const path=session(meeting.id)+'/media',flags={microphone:false,camera:false,screen:false}
    const legacy=(await ok(a,path,flags)).session.participants.find(p=>p.deviceId===a.deviceId)
    assert.equal(legacy.screenAudio,false,'Clients omitting screenAudio must remain silent')
    assert.equal((await comm(a,path,{...flags,screenAudio:true})).status,400,'Screen audio without screen capture was accepted')
    for(const screenAudio of ['true',1,null])assert.equal((await comm(a,path,{...flags,screen:true,screenAudio})).status,400,'Non-boolean screenAudio was accepted')
    const sharing=(await ok(a,path,{...flags,screen:true,screenAudio:true})).session.participants.find(p=>p.deviceId===a.deviceId)
    assert.equal(sharing.screen,true);assert.equal(sharing.screenAudio,true)
    assert.equal((await ok(a,'/state')).sessions.find(s=>s.id===meeting.id).participants.find(p=>p.deviceId===a.deviceId).screenAudio,true)
    await api('/api/communication'+path,{...flags,screen:true,screenAudio:true})
    for(const index of [3,4]){
      a.connection.socket.send(JSON.stringify({type:'signal',sessionId:meeting.id,targetId:'pc:'+roomId,signal:{type:'ice',candidate:{candidate:'candidate:qa 1 udp 1 127.0.0.1 9000 typ host',sdpMid:String(index),sdpMLineIndex:index}}}))
      const forwarded=await until(()=>pc.messages.find(m=>m.type==='signal'&&m.sessionId===meeting.id&&m.signal?.candidate?.sdpMLineIndex===index))
      assert.equal(forwarded.fromId,a.deviceId)
    }
    const before=a.connection.messages.length
    a.connection.socket.send(JSON.stringify({type:'signal',sessionId:meeting.id,targetId:'pc:'+roomId,signal:{type:'ice',candidate:{candidate:'candidate:qa 1 udp 1 127.0.0.1 9000 typ host',sdpMid:'5',sdpMLineIndex:5}}}))
    await until(()=>a.connection.messages.slice(before).find(m=>m.type==='error'&&m.status===400))
    assert.ok(!pc.messages.some(m=>m.type==='signal'&&m.sessionId===meeting.id&&m.signal?.candidate?.sdpMLineIndex===5),'Invalid ICE index reached another participant')
    const stopped=(await ok(a,path,{...flags,screenAudio:false})).session.participants.find(p=>p.deviceId===a.deviceId)
    assert.equal(stopped.screenAudio,false);assert.equal(stopped.screen,false)
    await ok(a,path,{...flags,screen:true,screenAudio:true})
    const ended=(await api('/api/communication/sessions/'+meeting.id+'/end',{})).session
    assert.equal(ended.status,'ended');assert.ok(ended.participants.every(p=>!p.microphone&&!p.camera&&!p.screen&&!p.screenAudio),'Ended session retained capture flags')
  })
  await check('duplicate names/models, cross-room targets, and self targets are explicit errors',async()=>{
    const twin=await join('另一个设备',{model:'测试型号B'})
    assert.equal((await comm(a,'/calls',{targetId:'测试型号B'})).status,409)
    assert.equal((await comm(a,'/calls',{targetId:other.deviceId})).status,404)
    assert.equal((await comm(a,'/calls',{targetId:a.deviceId})).status,400)
    const call=(await ok(a,'/calls',{targetId:twin.deviceId})).session;await ok(twin,'/calls/'+call.id+'/decision',{accept:false})
  })
  await check('physical media ownership is atomic under concurrent join requests',async()=>{
    const m1=(await api('/api/communication/meetings',{title:'并发一',visibility:'public',inviteeIds:[]})).session
    await ok(observer,session(expiringMeeting.id)+'/end',{})
    const m2=(await ok(observer,'/meetings',{title:'并发二',visibility:'public',inviteeIds:[]})).session
    const replies=await Promise.all([comm(a,'/meetings/'+m1.id+'/join',{}),comm(a,'/meetings/'+m2.id+'/join',{})]);assert.deepEqual(replies.map(r=>r.status).sort(),[200,409])
    const own=(await ok(a,'/state')).activeSessionId;await ok(a,session(own)+'/leave',{})
    await api('/api/communication/sessions/'+m1.id+'/end',{});await ok(observer,session(m2.id)+'/end',{})
    // Keep an invitation alive for the real 120-second expiry gate below.
    const replacement=(await ok(observer,'/meetings',{title:'真实邀请过期',visibility:'private',inviteeIds:[b.deviceId]})).session
    expiringInvite=(await ok(b,'/state')).invitations.find(i=>i.sessionId===replacement.id)
  })
  const profile=await api('/api/settings/profiles',{name:'本地工具契约',apiType:'chat_completions',apiUrl:'https://example.invalid/v1',apiKey:'contract-key',model:'fixture',maxCalls:10,maxSteps:10,timeoutSeconds:60})
  const start=(args,mode='automatic')=>api('/api/agent/runs',{targetId:'pc:'+roomId,profileId:profile.id,workspacePath:workspace,mode,task:JSON.stringify({tool:'arrange_communication',arguments:args})})
  const done=id=>until(async()=>(await api('/api/agent/runs')).find(r=>r.id===id&&r.status!=='running'))
  await check('PC Harness actual per-process pipe runs communication requests and request-mode approval',async()=>{
    const run=await done((await start({action:'call',targetId:a.deviceId})).id);assert.equal(run.status,'completed',run.result)
    const call=JSON.parse(run.result).session;assert.equal(call.callerId,'pc:'+roomId);assert.ok(call.participants.every(p=>!p.microphone&&!p.camera&&!p.screen))
    await ok(a,'/calls/'+call.id+'/decision',{accept:false})
    const pendingRun=await start({action:'meeting',title:'工具私密会议',visibility:'private',inviteeIds:[a.deviceId]},'request')
    const approval=await until(async()=>(await api('/api/state')).approvals.find(p=>p.runId===pendingRun.id))
    assert.equal(approval.tool,'arrange_communication');assert.equal(approval.arguments.sourceId,'pc:'+roomId);assert.deepEqual(approval.arguments.inviteeIds,[a.deviceId])
    assert.ok(!(await ok(a,'/state')).invitations.some(i=>i.title==='工具私密会议'))
    await api('/api/approvals/'+approval.id,{allow:true});const accepted=await done(pendingRun.id);assert.equal(accepted.status,'completed',accepted.result)
    const meeting=JSON.parse(accepted.result).session;assert.ok((await ok(a,'/state')).invitations.some(i=>i.sessionId===meeting.id));await api('/api/communication/sessions/'+meeting.id+'/end',{})
    const refused=await start({action:'call',targetId:a.deviceId},'request');const refusal=await until(async()=>(await api('/api/state')).approvals.find(p=>p.runId===refused.id))
    await api('/api/approvals/'+refusal.id,{allow:false});assert.equal((await done(refused.id)).status,'failed')
    assert.ok(!(await ok(a,'/state')).sessions.some(s=>s.status==='ringing'&&s.callerId==='pc:'+roomId))
  })
  await check('Android Agent tool binds the active run to its own device and keeps approval summaries bounded',async()=>{
    const started=await api('/api/agent/runs',{targetId:a.deviceId,profileId:profile.id,mode:'request',task:'本地通信工具协议'})
    await until(()=>a.agentTask===started.id)
    const listing=await mobile('/device/agent/communication/devices?taskId='+started.id,undefined,a.token);assert.equal(listing.status,200);assert.equal(listing.value.selfId,a.deviceId)
    assert.equal((await mobile('/device/agent/communication',{taskId:started.id,action:'call',targetId:b.deviceId,callerId:'pc:'+roomId},a.token)).status,400)
    assert.equal((await mobile('/device/agent/communication',{taskId:started.id,action:'call',targetId:b.deviceId},b.token)).status,404)
    const arranged=await mobile('/device/agent/communication',{taskId:started.id,action:'call',targetId:b.deviceId},a.token);assert.equal(arranged.status,200);assert.equal(arranged.value.session.callerId,a.deviceId)
    await ok(b,'/calls/'+arranged.value.session.id+'/decision',{accept:false})
    const approval={type:'agent_event',taskId:started.id,status:'permission_required',tool:'arrange_communication',requestId:'same-request',arguments:{action:'meeting',title:'手机会议',visibility:'private',inviteeIds:[b.deviceId]}}
    a.hub.send(JSON.stringify(approval));a.hub.send(JSON.stringify(approval))
    const pending=await until(async()=>(await api('/api/state')).approvals.find(p=>p.runId===started.id));assert.deepEqual(pending.arguments.inviteeIds,[b.deviceId])
    assert.equal((await api('/api/state')).approvals.filter(p=>p.runId===started.id).length,1)
    for(let i=0;i<620;i++)a.hub.send(JSON.stringify({type:'agent_event',taskId:started.id,status:'progress',text:'有界事件 '+i}))
    await until(async()=>(await api('/api/agent/runs')).find(r=>r.id===started.id).events.length===600)
    a.hub.send(JSON.stringify({type:'agent_event',taskId:started.id,status:'completed',text:'完成'}));await until(async()=>(await api('/api/agent/runs')).find(r=>r.id===started.id).status==='completed')
    assert.equal((await mobile('/device/agent/communication',{taskId:started.id,action:'call',targetId:b.deviceId},a.token)).status,409)
  })
  await check('communication reconnect preserves new sockets, while participant disconnect ends calls',async()=>{
    const call=(await ok(a,'/calls',{targetId:b.deviceId})).session;await ok(b,'/calls/'+call.id+'/decision',{accept:true})
    const previous=a.connection;const replacement=await connectCommunication(a);a.connection=replacement
    await delay(100);assert.equal((await ok(a,'/state')).activeSessionId,call.id);assert.notEqual(previous.socket.readyState,WebSocket.OPEN)
    b.connection.socket.close();await until(async()=>(await ok(a,'/state')).sessions.find(s=>s.id===call.id)?.status==='ended')
    b.connection=await connectCommunication(b)
  })
  await check('real 45-second unanswered calls expire and release physical ownership',async()=>{
    await until(async()=>(await ok(timerA,'/state')).sessions.find(s=>s.id===timedCall.id)?.status==='ended',50000)
    assert.equal((await ok(timerA,'/state')).sessions.find(s=>s.id===timedCall.id).endReason,'timeout')
    const next=(await ok(timerA,'/calls',{targetId:timerB.deviceId})).session;await ok(timerB,'/calls/'+next.id+'/decision',{accept:false})
  })
  await check('real 120-second private invitations expire and cannot be accepted afterwards',async()=>{
    await until(async()=>(await ok(b,'/state')).invitations.every(i=>i.id!==expiringInvite.id),125000)
    assert.equal((await comm(b,'/invitations/'+expiringInvite.id+'/decision',{accept:true})).status,404)
    const state=await ok(observer,'/state');for(const s of state.sessions.filter(s=>s.status==='active'))await ok(observer,session(s.id)+'/end',{})
  })
  await check('revoking a room member immediately closes its conference and media membership',async()=>{
    const doomedRoom=await api('/api/rooms',{name:'解散通信房间'}), doomed=await join('解散成员',{room:doomedRoom.id})
    const meeting=(await ok(doomed,'/meetings',{title:'删除时结束',visibility:'public',inviteeIds:[]})).session
    assert.equal(meeting.status,'active');await api('/api/rooms/'+doomedRoom.id,undefined,undefined,'DELETE')
    await until(()=>doomed.connection.socket.readyState===WebSocket.CLOSED)
    assert.equal((await comm(doomed,'/state')).status,401)
  })
  console.log(`Communication contract: ${count} checks passed; actual pinned TLS/WSS, both agent bridges, and wall-clock deadlines.`)
  await assertReleaseEvidenceUnchanged(artifacts)
}finally{
  for(const socket of sockets)socket.terminate()
  host.kill();await Promise.race([once(host,'exit'),delay(3000)])
  if(host.exitCode&&host.exitCode!==0&&diagnostic)console.error(diagnostic)
  await writeFile(resolve(data,'results.json'),JSON.stringify({hostVersion:release.version,artifacts,runtimeMode:'Controlled Harness transport fixture; native media and real models are verified separately.',results},null,2))
  console.log('Communication contract evidence: '+resolve(data,'results.json'))
}
