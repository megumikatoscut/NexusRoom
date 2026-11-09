import { projectPath } from '../scripts/submission-paths.mjs';
import assert from 'node:assert/strict'
import {spawn,execFileSync} from 'node:child_process'
import {once} from 'node:events'
import {createHash} from 'node:crypto'
import {mkdir,mkdtemp,cp,symlink,writeFile,readFile} from 'node:fs/promises'
import {resolve,dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import https from 'node:https'
import WebSocket from 'ws'
import {captureReleaseEvidence,assertReleaseEvidenceUnchanged} from './release-evidence.mjs'

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const release=JSON.parse(await readFile(projectPath(root,'release.json'),'utf8'))
const secret=process.env.NEXUS_TEST_API_KEY
if(!secret)throw new Error('Set NEXUS_TEST_API_KEY in the process environment; credentials are never placed in source or test logs.')
delete process.env.NEXUS_TEST_API_KEY
const redact=value=>String(value).replaceAll(secret,'[REDACTED]')
const { windowsPayload } = await import('./windows-payload.mjs');
const runtimePackage=resolve(process.env.NEXUS_TEST_RUNTIME_PACKAGE||windowsPayload(root,release.version))
const sourceHost=resolve(process.env.NEXUS_TEST_HOST_DIR||projectPath(root,'src/NexusRoom.Host/bin/Debug/net10.0-windows'))
const hostExecutable=process.env.NEXUS_TEST_HOST_EXE?resolve(process.env.NEXUS_TEST_HOST_EXE):''
const artifacts=await captureReleaseEvidence({hostExecutable:hostExecutable||undefined,hostDll:hostExecutable?undefined:join(sourceHost,'NexusRoom.Host.dll'),apk:process.env.NEXUS_TEST_APK,runtimePackage})
const model=process.env.NEXUS_TEST_MODEL||'deepseek-flash',apiUrl=process.env.NEXUS_TEST_API_URL||'https://api.deepseek.com',apiType=process.env.NEXUS_TEST_API_TYPE||'chat_completions'
const port=Number(process.env.NEXUS_COMMUNICATION_AGENT_PORT||19890),origin='http://127.0.0.1:'+port
await mkdir(projectPath(root,'.local'),{recursive:true})
const data=await mkdtemp(projectPath(root,'.local/communication-agent-live-')),hostDirectory=hostExecutable?dirname(hostExecutable):join(data,'host'),workspace=join(data,'workspace')
if(!hostExecutable){await cp(sourceHost,hostDirectory,{recursive:true,filter:path=>!path.startsWith(join(sourceHost,'runtime'))});await symlink(join(runtimePackage,'runtime'),join(hostDirectory,'runtime'),'junction')}
await mkdir(workspace,{recursive:true})
const hostEnvironment={...process.env,NEXUS_DATA_DIR:join(data,'state'),NEXUS_UI_PORT:String(port),NEXUS_DEVICE_PORT:String(port+1),NEXUS_DISCOVERY_PORT:String(port+2),NEXUS_DISABLE_MDNS:'1'}
if(hostExecutable)delete hostEnvironment.NEXUS_HARNESS_DIR;else hostEnvironment.NEXUS_HARNESS_DIR=join(runtimePackage,'runtime/harness')
const child=spawn(hostExecutable||'dotnet',hostExecutable?['--headless']:[join(hostDirectory,'NexusRoom.Host.dll'),'--headless'],{cwd:hostExecutable?hostDirectory:root,windowsHide:true,
  env:hostEnvironment,
  stdio:['ignore','ignore','pipe']})
let hostErrors='',token='',roomId='',fingerprint='',activeRun=''
child.stderr.on('data',chunk=>hostErrors=redact(hostErrors+chunk.toString()).slice(-8000))
const sockets=[],results=[],traces=[]
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(predicate,timeout=180000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await predicate();if(value)return value;await delay(200)}throw new Error('Real model tool check timed out')}
async function api(path,body,method=body===undefined?'GET':'POST'){
  const response=await fetch(origin+path,{method,headers:{Authorization:'Bearer '+token,'X-Nexus-Request':'1','X-Nexus-Room':roomId,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)})
  const value=await response.json();if(!response.ok)throw new Error(path+' HTTP '+response.status+': '+redact(value.title||'request failed'));return value
}
function mobile(member,path,body){
  return new Promise((resolve,reject)=>{const request=https.request('https://127.0.0.1:'+(port+1)+path,{agent:false,rejectUnauthorized:false,
    method:body===undefined?'GET':'POST',headers:{Authorization:member?'Bearer '+member.token:'','Content-Type':'application/json'}},response=>{
      if(createHash('sha256').update(response.socket.getPeerCertificate().raw).digest('hex')!==fingerprint){response.destroy();reject(new Error('Certificate pin mismatch'));return}
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString());if(response.statusCode!==200)reject(new Error(path+' HTTP '+response.statusCode+': '+redact(value.title||'request failed')));else resolve(value)}catch(error){reject(error)}})
    });request.on('error',reject);request.end(body===undefined?undefined:JSON.stringify(body))})
}
async function socket(url,authorization,hello){
  const ws=new WebSocket(url,{rejectUnauthorized:false,headers:{Authorization:'Bearer '+authorization}});sockets.push(ws);ws.on('error',()=>{})
  await once(ws,'open');if(url.startsWith('wss:'))assert.equal(createHash('sha256').update(ws._socket.getPeerCertificate().raw).digest('hex'),fingerprint)
  if(hello)ws.send(JSON.stringify(hello))
  const ticker=setInterval(()=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(hello||{type:'ping'}))},10000);ws.on('close',()=>clearInterval(ticker));return ws
}
async function phone(name,model){
  const invitation=await api('/api/invitation'),member=await mobile(null,'/device/join',{roomId,password:invitation.password,name,model,physicalId:name,version:'real-model-signaling-fixture'})
  await socket('wss://127.0.0.1:'+(port+1)+'/device/ws',member.token,{type:'heartbeat',model,permissions:{agent:true,files:true}})
  await until(async()=>(await api('/api/state')).devices.some(d=>d.id===member.deviceId&&d.online),15000)
  await socket('wss://127.0.0.1:'+(port+1)+'/device/communication/ws',member.token)
  return member
}
async function run(task,mode,profile){
  const started=await api('/api/agent/runs',{targetId:'pc:'+roomId,task,mode,profileId:profile.id,workspacePath:workspace});activeRun=started.id
  let approved=false
  const done=await until(async()=>{
    const current=(await api('/api/agent/runs')).find(r=>r.id===started.id);assert.ok(current)
    if(mode==='request'&&!approved){
      const approval=(await api('/api/state')).approvals.find(p=>p.runId===started.id)
      if(approval){
        assert.equal(approval.tool,'arrange_communication','Model attempted another mutation instead of the dedicated communication tool')
        assert.equal(approval.arguments.sourceId,'pc:'+roomId)
        assert.ok(!(await api('/api/communication/state')).sessions.some(s=>s.status==='ringing'),'Request was created before approval')
        approved=true;await api('/api/approvals/'+approval.id,{allow:true})
      }
    }
    return current.status!=='running'?current:false
  },240000)
  activeRun='';traces.push({...done,task:redact(done.task),result:redact(done.result),events:JSON.parse(redact(JSON.stringify(done.events)))})
  assert.equal(done.status,'completed',redact(done.result))
  const tools=done.events.filter(e=>e.kind==='tool').map(e=>e.tool)
  assert.ok(tools.includes('arrange_communication'),'Real model did not execute arrange_communication')
  if(mode==='request')assert.equal(approved,true,'Real model did not create a reviewable approval')
  return {run:done,tools,approved}
}
async function check(name,action){const detail=await action();results.push({name,passed:true,...detail});console.log('PASS '+name+' '+JSON.stringify(detail))}
let a,b,outsider
try{
  await until(async()=>{if(child.exitCode!==null)throw new Error('Host stopped: '+hostErrors);try{return(await fetch(origin+'/health')).ok}catch{return false}},20000)
  const path=join(data,'state/launch.dat').replaceAll("'","''")
  const script="Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes('"+path+"'),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))"
  const launch=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true}).trim());token=new URL(launch).hash.slice('#bootstrap='.length)
  const initial=await api('/api/state');roomId=initial.room.id;fingerprint=initial.host.fingerprint
  assert.equal((await api('/health')).version,release.version)
  await socket('ws://127.0.0.1:'+port+'/api/communication/ws?roomId='+roomId,token)
  a=await phone('模型电话目标甲','通讯测试型号A');b=await phone('模型会议目标乙','通讯测试型号B');outsider=await phone('不应邀请的旁观者','通讯测试型号C')
  const profile=await api('/api/settings/profiles',{name:'仅隔离真实模型验证',apiType,apiUrl,apiKey:secret,model,maxCalls:16,maxSteps:16,timeoutSeconds:240})
  const connection=await api('/api/settings/test',{profileId:profile.id});assert.equal(connection.ok,true)
  console.log('Model connection verified: '+model+'; Harness kernel remains pinned to release.json; Host '+release.version+'.')
  await check('real PC Harness model sends an approved audio call from a natural instruction',async()=>{
    const value=await run('给通讯测试型号A打电话。','request',profile)
    const calls=(await api('/api/communication/state')).sessions.filter(s=>s.status==='ringing'&&s.kind==='call');assert.equal(calls.length,1)
    const call=calls[0];assert.equal(call.callerId,'pc:'+roomId);assert.equal(call.calleeId,a.deviceId);assert.ok(call.participants.every(p=>!p.microphone&&!p.camera&&!p.screen))
    assert.ok((await mobile(a,'/device/communication/state')).sessions.some(s=>s.id===call.id&&s.status==='ringing'))
    assert.ok(!(await mobile(outsider,'/device/communication/state')).sessions.some(s=>s.id===call.id))
    await mobile(a,'/device/communication/calls/'+call.id+'/decision',{accept:false})
    return {model,mode:'request',instruction:'给通讯测试型号A打电话。',tools:value.tools,approved:value.approved,callerFixed:true,hardwareDisabled:true}
  })
  await check('real PC Harness model creates a private meeting and invites two named device models',async()=>{
    const value=await run('发起一个名为“真实模型私密会议”的私密会议室，邀请通讯测试型号A、通讯测试型号B加入。','automatic',profile)
    const meeting=(await api('/api/communication/state')).sessions.find(s=>s.kind==='meeting'&&s.status==='active'&&s.title==='真实模型私密会议');assert.ok(meeting)
    assert.equal(meeting.hostId,'pc:'+roomId);assert.deepEqual(meeting.participants.map(p=>p.deviceId),['pc:'+roomId]);assert.ok(meeting.participants.every(p=>!p.microphone&&!p.camera&&!p.screen))
    for(const member of [a,b]){const state=await mobile(member,'/device/communication/state');assert.ok(state.invitations.some(i=>i.sessionId===meeting.id));assert.ok(!state.sessions.some(s=>s.id===meeting.id))}
    const hidden=await mobile(outsider,'/device/communication/state');assert.ok(!hidden.sessions.some(s=>s.id===meeting.id));assert.ok(!hidden.invitations.some(i=>i.sessionId===meeting.id))
    await api('/api/communication/sessions/'+meeting.id+'/end',{})
    return {model,mode:'automatic',tools:value.tools,invitations:2,privateVisibilityVerified:true,hardwareDisabled:true}
  })
  console.log('Real PC communication model: '+results.length+' checks passed. Authenticated Android peers are signaling fixtures; this does not certify native media.')
  await assertReleaseEvidenceUnchanged(artifacts)
}catch(error){results.push({name:'failure',passed:false,error:redact(error.message)});console.error(redact(error.message));if(hostErrors)console.error(redact(hostErrors));process.exitCode=1}
finally{
  if(activeRun)await api('/api/agent/runs/'+activeRun,undefined,'DELETE').catch(()=>{})
  await writeFile(join(data,'results.json'),redact(JSON.stringify({hostVersion:release.version,artifacts,runtimeMode:hostExecutable?'Formal EXE with its bundled Node and Harness':'Debug Host with the selected bundled runtime',model,apiUrl,results,traces},null,2)))
  for(const ws of sockets)ws.terminate();child.kill();await Promise.race([once(child,'exit'),delay(3000)])
  console.log('Sanitized evidence: '+join(data,'results.json'))
}
