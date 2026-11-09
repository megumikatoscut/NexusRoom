import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, access, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import readline from 'node:readline';
import { chromium } from 'playwright';

// Interactive engineering harness for one explicitly selected physical Android
// and the actual Windows EXE/WebView. No bootstrap/token is written to evidence.
const root=resolve(import.meta.dirname,'..'), release=JSON.parse(await readFile(join(root,'release.json'),'utf8'));
const serial=process.env.NEXUS_QA_SERIAL; assert.ok(serial,'Set explicit NEXUS_QA_SERIAL');
const exe=process.env.NEXUS_TEST_HOST; assert.ok(exe,'Set explicit current Windows EXE');
const apk=process.env.NEXUS_TEST_APK; assert.ok(apk,'Set explicit signed current APK');
const data=resolve(process.env.NEXUS_QA_DATA||join(root,'.local/communication-audit/physical'));
const evidence=join(data,'evidence'); await mkdir(evidence,{recursive:true});
const uiPort=19790, devicePort=19791, debugPort=19794;
const origin=`http://127.0.0.1:${uiPort}`;
const adbExe=process.env.NEXUS_QA_ADB||'adb';
const host=spawn(exe,[],{cwd:root,windowsHide:false,env:{...process.env,NEXUS_DATA_DIR:join(data,'state'),NEXUS_UI_PORT:String(uiPort),NEXUS_DEVICE_PORT:String(devicePort),NEXUS_DISCOVERY_PORT:'19792',NEXUS_DISABLE_MDNS:'1',WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${debugPort} --auto-select-desktop-capture-source=Entire screen --lang=en-US`},stdio:['ignore','pipe','pipe']});
let log=''; host.stdout.on('data',chunk=>log+=chunk);host.stderr.on('data',chunk=>log+=chunk);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,label='condition',timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){try{const value=await predicate();if(value)return value;}catch{}await pause(200);}throw new Error('Timed out: '+label);}
function adb(...args){try{return execFileSync(adbExe,['-s',serial,...args],{encoding:'utf8',windowsHide:true,timeout:35000,maxBuffer:8*1024*1024}).trim();}catch{throw new Error('ADB operation failed ('+args.slice(0,2).join(' ')+')');}}
const logSince=adb('shell',"date '+%m-%d %H:%M:%S.000'");
// Keep the native rendering evidence while it is produced. Some phones have
// only a 256 KiB logcat ring; camera/Surface logs can evict a first-frame event
// before a later check reads the ring again.
let nativeLog='';
const nativeLogger=spawn(adbExe,['-s',serial,'logcat','-T',logSince,'-s','NexusRoom.RTC:I','AndroidRuntime:E','*:S'],{windowsHide:true,stdio:['ignore','pipe','ignore']});
nativeLogger.stdout.on('data',chunk=>nativeLog+=chunk.toString());
function tree(){const raw=adb('exec-out','uiautomator','dump','/dev/tty');const xml=raw.match(/<\?xml[\s\S]*<\/hierarchy>/)?.[0];assert.ok(xml,'Android UI hierarchy');return [...xml.matchAll(/<node\b[^>]*>/g)].map(([tag])=>{const value={};for(const[,key,text]of tag.matchAll(/([\w-]+)="([^"]*)"/g))value[key]=text.replaceAll('&amp;','&').replaceAll('&quot;','"');value.bounds=value.bounds?.match(/-?\d+/g)?.map(Number)||[];return value;});}
async function tap(label){
  for(const down of [true,false]){
    let previous='';
    for(let retry=0;retry<24;retry++){
      const nodes=tree(),n=nodes.find(n=>(n.text===label||n['content-desc']===label||n['resource-id']===label)&&n.bounds[2]>n.bounds[0]&&n.bounds[3]>n.bounds[1]);
      if(n){assert.notEqual(n.enabled,'false',label+' disabled');const[x1,y1,x2,y2]=n.bounds;adb('shell','input','tap',String(Math.round((x1+x2)/2)),String(Math.round((y1+y2)/2)));await pause(500);return;}
      const scroll=nodes.find(n=>n.scrollable==='true');if(!scroll)break;
      const signature=JSON.stringify(nodes.map(n=>[n.text,n['content-desc'],n.bounds]));if(signature===previous)break;previous=signature;
      const[x1,y1,x2,y2]=scroll.bounds,x=String(Math.round((x1+x2)/2));
      adb('shell','input','swipe',x,String(Math.round(y1+(y2-y1)*(down?.75:.3))),x,String(Math.round(y1+(y2-y1)*(down?.3:.75))),'1500');
    }
  }
  throw new Error('Android target absent: '+label);
}
async function top(){for(let i=0;i<30;i++){const nodes=tree();if(nodes.some(n=>n.text==='通话与视频会议'&&n.bounds[3]>n.bounds[1]))return;const scroll=nodes.find(n=>n.scrollable==='true');if(!scroll)return;const[x1,y1,x2,y2]=scroll.bounds;adb('shell','input','swipe',String(Math.round((x1+x2)/2)),String(Math.round(y1+(y2-y1)*.2)),String(Math.round((x1+x2)/2)),String(Math.round(y1+(y2-y1)*.8)),'1500');} }
async function permission(){const node=tree().find(n=>/permission_allow_foreground_only_button|permission_allow_button/.test(n['resource-id']||''));if(node)await tap(node['resource-id']);}
async function shot(name){await writeFile(join(evidence,name+'.png'),execFileSync(adbExe,['-s',serial,'exec-out','screencap','-p'],{windowsHide:true,maxBuffer:16*1024*1024}));}
let token='', roomId='', device, browser, page, helper, hostPid=host.pid;
const previousLogLevel=adb('shell','getprop','log.tag.NexusRoom.RTC');
const results=[];
async function api(path,body,method=body===undefined?'GET':'POST'){const response=await fetch(origin+path,{method,headers:{Authorization:'Bearer '+token,'X-Nexus-Request':'1','X-Nexus-Room':roomId,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;}
async function state(){return api('/api/communication/state');}
async function active(){return (await state()).sessions.find(s=>s.status==='active');}
async function stats(){return page.evaluate(async()=>{const out=[];for(const pc of window.qaConnections||[]){const records=[...(await pc.getStats()).values()];out.push({state:pc.connectionState,rtp:records.filter(s=>['inbound-rtp','outbound-rtp'].includes(s.type)).map(s=>({type:s.type,kind:s.kind,mid:s.mid,bytes:s.bytesReceived??s.bytesSent,frames:s.framesDecoded,totalAudioEnergy:s.totalAudioEnergy,totalSamplesDuration:s.totalSamplesDuration,audioLevel:s.audioLevel}))});}return out;});}
function rtcLog(){return nativeLog;}
async function check(name,action){await action();results.push({name,passed:true});await save();console.log('PASS '+name);}
async function save(){await writeFile(join(evidence,'result.json'),JSON.stringify({version:release.version,androidVersionCode:release.androidVersionCode,serial,model:adb('shell','getprop','ro.product.model'),signalingServer:process.env.NEXUS_QA_LAN_SERVER,results},null,2));await writeFile(join(evidence,'native-rtc.log'),rtcLog());}
async function initialize(){
  // The single-EXE launcher exits successfully after starting its inner Host.
  // A cold extraction can take several minutes on a scanned Windows volume.
  await until(async()=>{assert.ok(host.exitCode===null||host.exitCode===0,'Windows launcher failed');return fetch(origin+'/health').then(r=>r.ok)},'Host health',300000);
  const launchFile=join(data,'state/launch.dat');await until(()=>access(launchFile).then(()=>true),'launch file');
  const launch=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Add-Type -AssemblyName System.Security;[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($env:NEXUS_QA_LAUNCH),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))'],{env:{...process.env,NEXUS_QA_LAUNCH:launchFile},encoding:'utf8',windowsHide:true}).trim());
  token=new URL(launch).hash.slice('#bootstrap='.length);roomId=(await api('/api/state')).room.id;
  hostPid=Number(execFileSync('powershell.exe',['-NoProfile','-Command',`$all=Get-CimInstance Win32_Process; $ids=@(${host.pid}); for($i=0;$i -lt 4;$i++){$ids+=@($all|Where-Object {$_.ParentProcessId -in $ids}|Select-Object -ExpandProperty ProcessId)}; $all|Where-Object {$_.ProcessId -in $ids -and $_.Name -eq 'NexusRoom.Host.exe'}|Select-Object -First 1 -ExpandProperty ProcessId`],{encoding:'utf8',windowsHide:true}).trim());
  assert.ok(hostPid,'Isolated desktop Host process');
  helper=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',join(root,'tests/fixtures/ApproveCommunicationMedia.ps1'),'-HostProcessId',String(hostPid)],{windowsHide:true,stdio:['ignore','ignore','ignore']});
  await until(()=>fetch(`http://127.0.0.1:${debugPort}/json/version`).then(r=>r.ok),'WebView CDP');
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);page=browser.contexts().flatMap(c=>c.pages())[0];
  await page.addInitScript(()=>{const Original=window.RTCPeerConnection;window.qaConnections=[];window.qaMediaStreams=[];window.RTCPeerConnection=class extends Original{constructor(...args){super(...args);window.qaConnections.push(this);}};const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async constraints=>{const stream=await original(constraints);window.qaMediaStreams.push({stream,constraints});return stream;};});
  await page.goto(launch);await page.getByRole('button',{name:'通话与会议',exact:true}).click();
  await page.evaluate(()=>{const Original=window.RTCPeerConnection;window.qaConnections=[];window.RTCPeerConnection=class extends Original{constructor(...args){super(...args);window.qaConnections.push(this);}};window.qaMediaStreams=[];const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async constraints=>{const stream=await original(constraints);window.qaMediaStreams.push({stream,constraints});return stream;};});
  adb('install','-r',apk);const meta=adb('shell','dumpsys','package','com.nexusroom.android');assert.ok(meta.includes('versionName='+release.version)&&meta.includes('versionCode='+release.androidVersionCode));
  adb('shell','setprop','log.tag.NexusRoom.RTC','I');adb('shell','am','force-stop','com.nexusroom.android');adb('shell','am','start','-n','com.nexusroom.android/.MainActivity');
  const invitation=await api('/api/invitation'),server=process.env.NEXUS_QA_LAN_SERVER;assert.ok(server,'Set LAN HTTPS URL');const url=new URL('nexusroom://join');url.searchParams.set('payload',JSON.stringify({...invitation,server}));
  // Invitation is passed to ADB in-memory, and never echoed or stored.
  adb('shell','am','start','-a','android.intent.action.VIEW','-d',url.href,'com.nexusroom.android');await pause(1000);await tap('加入房间');
  if(tree().some(n=>n.text==='一致，加入'))await tap('一致，加入');
  const model=adb('shell','getprop','ro.product.model');
  device=await until(async()=>(await api('/api/state')).devices.find(d=>d.online&&d.model===model),'physical member');
  await tap('通话与视频会议');await until(async()=>(await state()).devices.some(d=>d.id===device.id&&d.communicationOnline),'native communication connection');
  console.log(JSON.stringify({ready:true,version:release.version,device:device.model,hostPid,evidence}));
}
async function cleanup(){try{for(const s of (await state()).sessions.filter(s=>s.status!=='ended'))await api('/api/communication/sessions/'+s.id+'/end',{});await api('/api/rooms/'+roomId,undefined,'DELETE');}catch{}try{adb('shell','am','force-stop','com.nexusroom.qa.audio');adb('uninstall','com.nexusroom.qa.audio');adb('shell','setprop','log.tag.NexusRoom.RTC',previousLogLevel);}catch{}await pause(100);await save();nativeLogger.kill();helper?.kill();try{await browser?.close();}catch{}for(const id of new Set([hostPid,host.pid]))try{execFileSync('taskkill',['/PID',String(id),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}}
const rendered=()=>rtcLog().match(/videoFirstFrameRendered/g)?.length||0;
function frames(sessionId){return [...rtcLog().matchAll(/session=(\S+) peer=(\S+).*?cameraFrames=(\d+) screenFrames=(\d+)/g)].filter(m=>m[1]===sessionId).map(m=>({camera:Number(m[3]),screen:Number(m[4])})).at(-1)||{camera:0,screen:0};}
async function voiceSettings(){return page.evaluate(()=>window.qaMediaStreams.flatMap(({stream})=>stream.getAudioTracks().filter(t=>t.readyState==='live').map(t=>t.getSettings())));}
async function voiceReady(){await until(async()=>{const live=await voiceSettings();return live.some(s=>s.echoCancellation==='all'&&s.noiseSuppression&&s.autoGainControl===false);},'Windows all-device echo cancellation');await until(async()=>{const rtp=(await stats()).filter(s=>s.state==='connected').flatMap(s=>s.rtp);return ['inbound-rtp','outbound-rtp'].every(type=>rtp.some(s=>s.type===type&&s.mid==='0'&&s.bytes>1000));},'Physical bidirectional microphone RTP');}
async function mediaRegression(){
  let session;
  await check('Windows camera renders on physical Android while the screen receiver is inactive',async()=>{
    await page.getByRole('button',{name:'创建会议',exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'创建会议',exact:true}).click();
    session=await until(active,'active meeting');await tap('加入 · '+session.title);
    await until(async()=>(await active())?.participants.length===2,'physical meeting members');
    const before=rendered();await page.getByRole('button',{name:'开启摄像头',exact:true}).click();
    await page.getByRole('button',{name:'关闭摄像头',exact:true}).waitFor({timeout:65000});
    await until(()=>rendered()>before&&frames(session.id).camera>20,'decoded and rendered physical camera');
    await shot('camera');
  });
  await check('rapid camera off/on releases and reacquires Windows capture',async()=>{
    for(let i=0;i<2;i++){
      await page.getByRole('button',{name:'关闭摄像头',exact:true}).click();
      const before=rendered();await page.getByRole('button',{name:'开启摄像头',exact:true}).click();
      await page.getByRole('button',{name:'关闭摄像头',exact:true}).waitFor({timeout:65000});
      await until(()=>rendered()>before,'reopened Android camera renderer');
      assert.equal(await page.getByRole('alert').count(),0);
    }
  });
  await check('camera and screen stay in separate native rendering slots',async()=>{
    const before=rendered();await page.getByRole('button',{name:'共享屏幕',exact:true}).click();
    await page.getByRole('button',{name:'停止共享屏幕',exact:true}).waitFor({timeout:30000});
    await until(()=>rendered()>=before+2&&frames(session.id).screen>10,'camera plus screen rendering');
    const first=frames(session.id);await until(()=>{const next=frames(session.id);return next.camera>first.camera&&next.screen>first.screen;},'both native decoded video counters grow');
    await page.getByRole('button',{name:'停止共享屏幕',exact:true}).click();
  });
  await check('meeting microphones exchange physical audio with Windows all-device AEC',async()=>{
    await page.getByRole('button',{name:'开启麦克风',exact:true}).click();
    await page.getByRole('button',{name:'静音',exact:true}).waitFor({timeout:30000});
    await tap('开启麦克风');await permission();
    await until(async()=>(await active())?.participants.every(p=>p.microphone),'both meeting microphones');
    await voiceReady();await writeFile(join(evidence,'meeting-audio.json'),JSON.stringify({settings:await voiceSettings(),stats:await stats()},null,2));
    await page.getByRole('button',{name:'结束会议',exact:true}).click();
    await until(async()=>!(await active()),'meeting cleanup');
    await until(()=>rtcLog().includes('session='+session.id+' released microphone=false camera=false screen=false'),'native media cleanup');
    assert.deepEqual(await voiceSettings(),[]);
  });
  await check('private call microphone uses all-device AEC and releases capture on hangup',async()=>{
    await page.getByRole('button',{name:'呼叫',exact:true}).click();await tap('接听');await permission();
    session=await until(active,'accepted physical call');assert.equal(session.kind,'call');
    await voiceReady();await writeFile(join(evidence,'call-audio.json'),JSON.stringify({settings:await voiceSettings(),stats:await stats()},null,2));
    await page.getByRole('button',{name:'挂断',exact:true}).click();await until(async()=>!(await active()),'call cleanup');
    await until(async()=>(await voiceSettings()).length===0,'Windows microphone released');
    await until(()=>rtcLog().includes('session='+session.id+' released microphone=false camera=false screen=false'),'native call cleanup');
  });
}
try { await initialize(); } catch(error) { await cleanup(); throw error; }
if(process.argv.includes('--media-regression')){
  try{await mediaRegression();}finally{await cleanup();}
}else if(process.argv.includes('--interactive')){
  const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
  for await(const command of input){if(command==='quit'){try{await cleanup();}finally{input.close();process.stdin.destroy();}break;}await appendFile(join(evidence,'steps.mjs'),command+'\n');try{const result=await eval(`(async()=>{${command}\n})()`);console.log('RESULT '+JSON.stringify(result));}catch(error){console.log('ERROR '+error.stack);}}
}else{throw new Error('Use --interactive to perform explicit hardware checks and record results');}
