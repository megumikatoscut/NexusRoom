import { projectPath } from '../scripts/submission-paths.mjs';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import WebSocket from 'ws';

// Runs the real Android-local Agent and model, with an isolated running Host.
// The temporary model profile and all decrypted credentials stay outside reports.
const root=resolve(import.meta.dirname,'..');
const release=JSON.parse(await readFile(projectPath(root,'release.json'),'utf8'));
const data=resolve(process.env.NEXUS_ANDROID_COMMUNICATION_DATA||projectPath(root,'.local/communication-android-v'+release.version));
const evidence=join(data,'evidence');await mkdir(evidence,{recursive:true});
const adbExe=process.env.NEXUS_QA_ADB||'adb';
const prepared=JSON.parse(await readFile(join(data,'prepared.json'),'utf8'));
const serials=prepared.serials;
const roomId=prepared.roomId;
function decrypt(path){return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
  'Add-Type -AssemblyName System.Security;[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($env:NEXUS_QA_SECRET_FILE),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))'],
  {env:{...process.env,NEXUS_QA_SECRET_FILE:path},encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','ignore']}).trim());}
const launchUrl=new URL(decrypt(process.env.NEXUS_LIVE_LAUNCH_FILE||prepared.launchFile));
const origin=launchUrl.origin,token=decodeURIComponent(launchUrl.hash.slice('#bootstrap='.length));
let modelProfile;
if(process.env.NEXUS_TEST_API_KEY)modelProfile={apiKey:process.env.NEXUS_TEST_API_KEY,apiUrl:process.env.NEXUS_TEST_API_URL||'https://api.deepseek.com',model:process.env.NEXUS_TEST_MODEL||'deepseek-flash',apiType:'chat_completions'};
else {
  assert.ok(process.env.NEXUS_QA_MODEL_STATE,'Provide NEXUS_TEST_API_KEY or an isolated NEXUS_QA_MODEL_STATE');
  const state=decrypt(process.env.NEXUS_QA_MODEL_STATE);
  modelProfile=state.rooms.flatMap(r=>r.agentProfiles).find(p=>p.model==='deepseek-flash'&&p.apiKey);
}
assert.ok(modelProfile?.apiKey,'No configured DeepSeek profile for the live audit');
const redact=value=>String(value).replaceAll(modelProfile.apiKey,'[redacted]').replaceAll(token,'[redacted]').replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g,'[redacted]');
const results=[],traces=[],artifacts={};let profileId='',activeRun='',pcSocket;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,message,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){const result=await predicate();if(result)return result;await pause(250);}throw new Error(message);}
async function api(path,body,method=body===undefined?'GET':'POST'){
  const response=await fetch(origin+path,{method,headers:{Authorization:'Bearer '+token,'X-Nexus-Request':'1','X-Nexus-Room':roomId,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const value=await response.json();if(!response.ok)throw new Error('Host HTTP '+response.status+': '+redact(value.title||'request failed'));return value;
}
function adb(serial,...args){return execFileSync(adbExe,['-s',serial,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:8*1024*1024}).trim();}
function tree(serial){const raw=adb(serial,'exec-out','uiautomator','dump','/dev/tty'),xml=raw.match(/<\?xml[\s\S]*<\/hierarchy>/)?.[0];assert.ok(xml,'Android UI tree missing');return [...xml.matchAll(/<node\b[^>]*>/g)].map(([tag])=>{const node={};for(const [,key,value]of tag.matchAll(/([\w-]+)="([^"]*)"/g))node[key]=value.replaceAll('&quot;','"').replaceAll('&amp;','&');node.bounds=node.bounds?.match(/\d+/g)?.map(Number)||[];return node;});}
function swipe(serial,nodes){const scroll=nodes.find(n=>n.scrollable==='true');if(!scroll)return false;const [x1,y1,x2,y2]=scroll.bounds;adb(serial,'shell','input','swipe',String((x1+x2)/2),String(y1+(y2-y1)*.75),String((x1+x2)/2),String(y1+(y2-y1)*.25),'350');return true;}
async function tap(serial,label){for(let i=0;i<9;i++){const nodes=tree(serial),node=nodes.find(n=>(typeof label==='function'?label(n):n.text?.toLocaleLowerCase()===label.toLocaleLowerCase()||n['content-desc']===label||n['resource-id']===label)&&n.bounds[2]>n.bounds[0]&&n.bounds[3]>n.bounds[1]);if(node){assert.notEqual(node.enabled,'false','Disabled UI action '+label);const [x1,y1,x2,y2]=node.bounds;adb(serial,'shell','input','tap',String((x1+x2)/2),String((y1+y2)/2));await pause(300);return;}if(!swipe(serial,nodes))break;}throw new Error('Native Agent UI action missing: '+label);}
async function openCommunication(serial){adb(serial,'shell','am','start','--activity-clear-top','--activity-single-top','-n','com.nexusroom.android/.MainActivity');for(let i=0;i<8;i++){const nodes=tree(serial);if(nodes.some(n=>n.text==='通话与视频会议'))break;const scroll=nodes.find(n=>n.scrollable==='true');if(!scroll)break;const [x1,y1,x2,y2]=scroll.bounds;adb(serial,'shell','input','swipe',String((x1+x2)/2),String(y1+(y2-y1)*.25),String((x1+x2)/2),String(y1+(y2-y1)*.75),'300');}await tap(serial,'通话与视频会议');}
async function screenshot(serial,name){await writeFile(join(evidence,name+'.png'),execFileSync(adbExe,['-s',serial,'exec-out','screencap','-p'],{windowsHide:true,maxBuffer:12*1024*1024}));}
async function check(name,action){const detail=await action();results.push({name,passed:true,...detail});console.log('PASS '+name);}
async function run(task,mode,deviceId){
  const started=await api('/api/agent/runs',{targetId:deviceId,profileId,task,mode});activeRun=started.id;let approved=false;
  const completed=await until(async()=>{
    const current=(await api('/api/agent/runs')).find(r=>r.id===started.id);assert.ok(current,'Native run disappeared');
    if(mode==='request'&&!approved){const approval=(await api('/api/state')).approvals.find(a=>a.runId===started.id);if(approval){assert.equal(approval.tool,'arrange_communication');assert.ok(!tree(serials[1]).some(n=>n.text==='私人音频来电'),'Call created before request-mode approval');await until(()=>tree(serials[0]).some(n=>n.text==='允许一次'),'Native approval dialog was not shown');await screenshot(serials[0],'native-agent-call-approval');await tap(serials[0],'允许一次');approved=true;}}
    return current.status==='running'?false:current;
  },'Native real model run did not complete',240000);
  activeRun='';traces.push(completed);assert.equal(completed.status,'completed',redact(completed.result));assert.equal(completed.deviceId,deviceId);
  const tools=completed.events.filter(e=>e.kind==='tool').map(e=>e.tool);assert.ok(tools.includes('list_room_devices'),'Model did not list authenticated room devices');assert.ok(tools.includes('arrange_communication'),'Model did not execute the new native tool');assert.ok(tools.every(t=>['list_room_devices','arrange_communication'].includes(t)),'Unexpected native tool');
  const finished=completed.events.findLast(e=>e.tool==='arrange_communication'&&e.kind==='status'&&e.text==='安排会议或通话完成');assert.ok(finished,'Native tool completion absent');if(mode==='request')assert.equal(approved,true);
  return {tools,approved};
}
try{
  const state=await api('/api/state'),a=state.devices.find(d=>d.id===prepared.deviceIds[0]),b=state.devices.find(d=>d.id===prepared.deviceIds[1]);assert.ok(a?.online&&b?.online,'Prepare two native room members first');
  assert.equal((await api('/health')).version,release.version);
  if(process.env.NEXUS_QA_APK)artifacts.apk={path:resolve(process.env.NEXUS_QA_APK),sha256:createHash('sha256').update(await readFile(process.env.NEXUS_QA_APK)).digest('hex')};
  if(process.env.NEXUS_QA_HOST_EXE)artifacts.host={path:resolve(process.env.NEXUS_QA_HOST_EXE),sha256:createHash('sha256').update(await readFile(process.env.NEXUS_QA_HOST_EXE)).digest('hex')};
  pcSocket=new WebSocket(origin.replace(/^http/,'ws')+'/api/communication/ws?roomId='+roomId,{headers:{Authorization:'Bearer '+token}});pcSocket.on('error',()=>{});await once(pcSocket,'open');
  const ticker=setInterval(()=>{if(pcSocket.readyState===WebSocket.OPEN)pcSocket.send(JSON.stringify({type:'ping'}));},10000);pcSocket.on('close',()=>clearInterval(ticker));
  const profile=await api('/api/settings/profiles',{name:'Android native communication live QA',apiType:modelProfile.apiType,apiUrl:modelProfile.apiUrl,apiKey:modelProfile.apiKey,model:modelProfile.model,maxCalls:12,maxSteps:12,timeoutSeconds:240});profileId=profile.id;
  assert.equal((await api('/api/settings/test',{profileId})).ok,true,'Live provider connection test failed');
  await openCommunication(serials[1]);
  await check('Android Agent panel has the new communication tool and fixes the task target to this phone',async()=>{
    adb(serials[0],'shell','am','start','--activity-clear-top','--activity-single-top','-n','com.nexusroom.android/.MainActivity');
    const allowed=(await api('/api/state')).devices.find(d=>d.id===a.id).permissions.agent;
    if(!allowed){await tap(serials[0],'Agent 操作');await tap(serials[0],'允许 Agent');await until(async()=>(await api('/api/state')).devices.find(d=>d.id===a.id).permissions.agent,'Native Agent authorization absent');}
    await tap(serials[0],'打开 Agent 悬浮窗');await tap(serials[0],'安排会议或通话');await tap(serials[0],'拨打私人音频电话');await tap(serials[0],n=>n.text?.startsWith(b.name+' · '));
    const nodes=tree(serials[0]);assert.ok(nodes.some(n=>n.text==='目标设备：本机'));assert.ok(nodes.some(n=>n['content-desc']==='输入 Agent 任务'&&n.text.includes(b.id)));await screenshot(serials[0],'native-agent-arrange-self');
    return {targetIsSelf:true};
  });
  await check('real Android-local DeepSeek model lists devices then sends a reviewed call to a device model',async()=>{
    const value=await run('给 '+b.model+'（房间内设备名称 '+b.name+'）打电话。','request',a.id);
    await until(()=>tree(serials[1]).some(n=>n.text==='私人音频来电'),'Native callee did not receive the real model call');assert.ok(tree(serials[1]).some(n=>n.text.includes(a.name)&&n.text.includes(a.model)&&n.text.includes('请求与你通话')),'Incoming call actor differs from native task target');assert.ok(!(await api('/api/communication/state')).sessions.some(s=>s.kind==='call'&&s.status==='ringing'),'Private native call leaked to unrelated PC');await screenshot(serials[1],'native-agent-incoming-call');await tap(serials[0],'收起 Agent 悬浮窗');await openCommunication(serials[0]);assert.ok(tree(serials[0]).some(n=>n.text==='等待对方接听'));assert.ok(tree(serials[0]).some(n=>n.text.includes(b.name)&&n.text.includes(b.model)&&n.text.startsWith('正在呼叫')));for(const serial of serials)assert.match(adb(serial,'shell','dumpsys','audio'),/Requested mode = MODE_NORMAL/,'Ringing Agent call acquired the audio route');await tap(serials[1],'拒绝');await until(async()=>!(await api('/api/communication/state')).devices.find(d=>d.id===a.id)?.busy,'Native call rejection did not free caller');adb(serials[0],'shell','am','start','--activity-clear-top','--activity-single-top','-n','com.nexusroom.android/.MainActivity');await tap(serials[0],'打开 Agent 悬浮窗');
    return {model:modelProfile.model,tools:value.tools,approved:value.approved,callerFixed:true,hardwareDisabled:true};
  });
  await check('real Android-local DeepSeek model creates a private meeting and invites native Android and Windows',async()=>{
    const pc=(await api('/api/communication/state')).devices.find(d=>d.id==='pc:'+roomId);assert.ok(pc?.communicationOnline);
    const value=await run('发起一个私密会议室，名称“安卓真实模型会议”，邀请 '+b.model+'（设备名称 '+b.name+'）和 '+pc.name+' 加入。','automatic',a.id);
    const pcState=await api('/api/communication/state'),invitation=pcState.invitations.find(i=>i.title==='安卓真实模型会议');assert.ok(invitation,'Windows meeting invitation absent');assert.equal(invitation.hostId,a.id);assert.equal(invitation.visibility,'private');assert.ok(!pcState.sessions.some(s=>s.id===invitation.sessionId),'Private meeting visible before invitation accepted');await until(()=>tree(serials[1]).some(n=>n.text?.includes('会议邀请 · 安卓真实模型会议')),'Native meeting invitation absent');await screenshot(serials[1],'native-agent-private-invitation');await tap(serials[1],'拒绝邀请');
    await tap(serials[0],'收起 Agent 悬浮窗');await openCommunication(serials[0]);assert.ok(tree(serials[0]).some(n=>n.text==='私密会议 · 邀请制'));assert.ok(tree(serials[0]).some(n=>n.text===a.name+'（我） · 主持人 · 麦克风关'));assert.ok(tree(serials[0]).some(n=>n.text==='开启摄像头'));await screenshot(serials[0],'native-agent-private-host-muted');const joined=await api('/api/communication/invitations/'+invitation.id+'/decision',{accept:true});assert.equal(joined.session.kind,'meeting');assert.equal(joined.session.visibility,'private');assert.equal(joined.session.hostId,a.id);assert.deepEqual(joined.session.participants.map(p=>p.deviceId).sort(),[a.id,pc.id].sort());assert.ok(joined.session.participants.every(p=>!p.microphone&&!p.camera&&!p.screen));await tap(serials[0],'结束会议');await tap(serials[0],'结束');await until(async()=>!(await api('/api/communication/state')).sessions.some(s=>s.id===invitation.sessionId&&s.status==='active'),'Native Agent-created private meeting did not end');
    return {model:modelProfile.model,tools:value.tools,invitations:2,privateVisibilityVerified:true,hardwareDisabled:true};
  });
}catch(error){results.push({name:'failure',passed:false,error:redact(error.message)});console.error(redact(error.message));process.exitCode=1;}
finally{
  if(activeRun)await api('/api/agent/runs/'+activeRun,undefined,'DELETE').catch(()=>{});
  if(profileId)await api('/api/settings/profiles/'+profileId,undefined,'DELETE').catch(()=>{});
  pcSocket?.terminate();
  await writeFile(join(evidence,'android-agent-result.json'),redact(JSON.stringify({version:release.version,model:modelProfile.model,serials,artifacts,results,traces},null,2)));
  console.log('Sanitized Android Agent evidence: '+join(evidence,'android-agent-result.json'));
}
