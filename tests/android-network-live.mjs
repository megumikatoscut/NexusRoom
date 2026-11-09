import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import { writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Disposable-device QA only. Requires an explicitly selected ADB serial and
// real Android app; never reads, logs or rewrites its encrypted room vault.
const root=resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release=JSON.parse(await readFile(resolve(root,'release.json'),'utf8'));
const serial=process.env.NEXUS_QA_SERIAL;
if(!serial)throw new Error('Set NEXUS_QA_SERIAL to an isolated test emulator.');
const adbExe=process.env.NEXUS_QA_ADB || 'adb';
const { windowsPayload } = await import('./windows-payload.mjs');
const hostExe=resolve(process.env.NEXUS_NETWORK_HOST || resolve(windowsPayload(root,release.version),'NexusRoom.Host.exe'));
const data=resolve(process.env.NEXUS_NETWORK_DATA || resolve(root,'.local','network-device-v'+release.version+'-'+Date.now()));
const uiPort=Number(process.env.NEXUS_NETWORK_UI_PORT || 18190);
const ports=(process.env.NEXUS_NETWORK_DEVICE_PORTS || '18191,18193,18194').split(',').map(Number);
const initialHost=process.env.NEXUS_NETWORK_INITIAL_HOST || '10.10.1.71';
const apk=process.env.NEXUS_TEST_APK || process.env.NEXUS_QA_APK;
const resume=process.env.NEXUS_QA_RESUME==='after_wifi';
const base='http://127.0.0.1:'+uiPort;
const packageName='com.nexusroom.android';
const outcomes=[];
const platformObservations=[];
let headers,roomId,memberId,hostPid,currentPort,permissions,roomOpened=true;
let packageInfo;
mkdirSync(data,{recursive:true});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function adb(...args){try{return execFileSync(adbExe,['-s',serial,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:args[0]==='install'?90000:12000}).trim();}catch{throw new Error('ADB '+args.slice(0,2).join(' ')+' failed on isolated device '+serial);}}
function adbAsync(...args){return new Promise((resolve,reject)=>{const child=spawn(adbExe,['-s',serial,...args],{windowsHide:true,stdio:['ignore','pipe','pipe']});const timer=setTimeout(()=>{child.kill();reject(new Error('Timed out Android virtual Wi-Fi cycle'));},22000);child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('exit',code=>{clearTimeout(timer);if(code===0)resolve();else reject(new Error('Android virtual Wi-Fi cycle returned '+code));});});}
async function until(check,label,timeout=70000){const deadline=Date.now()+timeout;while(Date.now()<deadline){try{const value=await check();if(value)return value;}catch{}await pause(500);}throw new Error('Timed out: '+label);}
async function api(path,body,method){const response=await fetch(base+path,{method:method || (body===undefined?'GET':'POST'),headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});const value=await response.json();assert.ok(response.ok,path+' returned HTTP '+response.status);return value;}
async function session(){
 const file=resolve(data,'launch.dat').replaceAll("'","''");
 const script="Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes('"+file+"'),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))";
 const launch=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim());
 headers={Authorization:'Bearer '+new URL(launch).hash.slice('#bootstrap='.length),'X-Nexus-Request':'1','Content-Type':'application/json'};
 if(roomId)headers['X-Nexus-Room']=roomId;
}
async function startHost(port){
 currentPort=port;const log=openSync(resolve(data,'host-'+port+'.log'),'a');
 const child=spawn(hostExe,['--headless'],{cwd:dirname(hostExe),detached:true,windowsHide:true,stdio:['ignore',log,log],env:{...process.env,NEXUS_DATA_DIR:data,NEXUS_UI_PORT:String(uiPort),NEXUS_DEVICE_PORT:String(port),NEXUS_DISCOVERY_PORT:'17892',NEXUS_DISABLE_MDNS:process.env.NEXUS_NETWORK_DISABLE_MDNS || '0'}});
 closeSync(log);child.unref();hostPid=child.pid;
 await until(async()=>{const response=await fetch(base+'/health',{signal:AbortSignal.timeout(1000)});return response.ok&&(await response.json()).version===release.version;},'isolated current-version host startup',20000);await session();
}
async function stopHost(){if(hostPid){try{process.kill(hostPid);}catch{}await until(async()=>{try{await fetch(base+'/health',{signal:AbortSignal.timeout(700)});return false;}catch{return true;}},'old listener shutdown',10000);hostPid=undefined;}}
function nodes(){
 adb('shell','uiautomator','dump','/sdcard/nexusroom-network-live.xml');
 const xml=adb('exec-out','cat','/sdcard/nexusroom-network-live.xml');
 const decode=text=>text.replaceAll('&quot;','"').replaceAll('&apos;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
 return [...xml.matchAll(/<node\b[^>]*>/g)].map(([tag])=>{const attr=name=>decode(tag.match(new RegExp('\\b'+name+'="([^"]*)"'))?.[1] || '');const bounds=(attr('bounds').match(/\d+/g)||[]).map(Number);return {text:attr('text'),description:attr('content-desc'),class:attr('class'),checked:attr('checked')==='true',enabled:attr('enabled')==='true',scrollable:attr('scrollable')==='true',bounds};}).filter(node=>node.bounds.length===4);
}
function tapNode(node){const [x1,y1,x2,y2]=node.bounds;adb('shell','input','tap',String(Math.round((x1+x2)/2)),String(Math.round((y1+y2)/2)));}
function swipe(container,up){const [x1,y1,x2,y2]=container.bounds,x=Math.round(x1+(x2-x1)*.55),top=Math.round(y1+(y2-y1)*.22),bottom=Math.round(y1+(y2-y1)*.82);adb('shell','input','swipe',String(x),String(up?top:bottom),String(x),String(up?bottom:top),'280');}
async function tapText(text,{scroll=true,kind}={}){
 for(let i=0;i<(scroll?9:2);i++){
  const tree=nodes(),node=tree.find(node=>(node.text.toLocaleLowerCase()===text.toLocaleLowerCase()||node.description.toLocaleLowerCase()===text.toLocaleLowerCase())&&node.enabled&&(!kind||node.class.endsWith(kind)));
  if(node){tapNode(node);await pause(350);return node;}
  const container=tree.find(node=>node.scrollable);if(!container)break;swipe(container,false);await pause(200);
 }
 throw new Error('Android UI target unavailable: '+text);
}
async function findSwitch(text){await top();for(let i=0;i<8;i++){const tree=nodes(),node=tree.find(node=>node.text===text&&node.class.endsWith('Switch'));if(node)return node;const container=tree.find(node=>node.scrollable);if(!container)break;swipe(container,false);}throw new Error('Saved Android permission switch missing: '+text);}
async function top(){const container=nodes().find(node=>node.scrollable);if(!container)return;for(let i=0;i<4;i++)swipe(container,true);}
async function screenshot(name){const remote='/sdcard/nexusroom-network-'+name+'.png';adb('shell','screencap','-p',remote);adb('pull',remote,resolve(data,name+'.png'));}
async function online(){return until(async()=>{const state=await api('/api/state');const member=state.devices.find(device=>device.id===memberId&&device.online);return member;},'same member online');}
async function offline(){return until(async()=>!(await api('/api/state')).devices.find(device=>device.id===memberId)?.online,'member offline',55000);}
async function address(){await top();return nodes().find(node=>node.class.endsWith('TextView')&&/^https:\/\//.test(node.text))?.text;}
async function join(){
 const invite=await api('/api/invitation');invite.server='https://'+initialHost+':'+currentPort;
 const url=new URL('nexusroom://join');url.searchParams.set('payload',JSON.stringify(invite));
 adb('shell','am','start','--activity-clear-top','--activity-single-top','-a','android.intent.action.VIEW','-d',url.toString(),'-n',packageName+'/.MainActivity');
 await pause(400);await tapText('加入房间');await tapText('一致，加入',{scroll:false});
 const member=await until(async()=>{const state=await api('/api/state');return state.devices.find(device=>device.online&&device.id!==memberId);},'actual Android invitation join',25000);memberId=member.id;return member;
}
async function authorize(){
 // This device is an explicitly isolated QA instance. Android's service grant
 // is applied here; each room's actual user permission switches still run.
 adb('shell','settings','put','secure','enabled_accessibility_services',packageName+'/.ControlService');
 adb('shell','settings','put','secure','accessibility_enabled','1');await pause(600);
 await top();await tapText('允许房间屏幕访问',{kind:'Switch'});
 await tapText('远程控制',{kind:'Switch'});await tapText('允许并继续',{scroll:false});
 // MainActivity resumes the pending room grant if Android opened Settings.
 adb('shell','am','start','--activity-clear-top','--activity-single-top','-n',packageName+'/.MainActivity');await pause(400);
 for(const text of ['文件传输','剪贴板同步']){await top();await tapText(text,{kind:'Switch'});}
 await top();await tapText('Agent 操作',{kind:'Switch'});await tapText('允许 Agent',{scroll:false});
 const member=await until(async()=>{const value=await online();return value.permissions.control&&value.permissions.files&&value.permissions.clipboard&&value.permissions.agent&&value.permissions.screenAllowed?value:false;},'authorized permission heartbeat',20000);
 permissions=member.permissions;return member;
}
function assertMembership(member,systemControl=true){assert.equal(member.id,memberId,'Room migration created a new member');for(const key of systemControl?['control','files','clipboard','agent','screenAllowed']:['files','clipboard','agent','screenAllowed'])assert.equal(member.permissions[key],permissions[key],'Room migration lost '+key+' permission');}
async function record(name,action){const at=Date.now();try{await action();outcomes.push({name,status:'passed',seconds:Number(((Date.now()-at)/1000).toFixed(1))});console.log('PASS '+name);}catch(error){outcomes.push({name,status:'failed',seconds:Number(((Date.now()-at)/1000).toFixed(1)),error:error.message});throw error;}}
async function save(status,error){await writeFile(resolve(data,'network-live-result.json'),JSON.stringify({status,error,version:release.version,packageInfo,serial,hostExe,dataDirectory:data,hostPid,uiOrigin:base,devicePort:currentPort,roomId,memberId,permissions,outcomes,platformObservations,scope:'Real MuMu Android 12 app, TLS, membership and UDP discovery across a virtual LAN host-address/port migration. This is not evidence of physical Wi-Fi router migration.',time:new Date().toISOString()},null,2));}

try{
 const listed=execFileSync(adbExe,['devices'],{encoding:'utf8',windowsHide:true});assert.ok(listed.includes(serial+'\tdevice'),'Chosen isolated emulator is not connected');
 if(apk){if(process.env.NEXUS_QA_REINSTALL==='1')try{adb('uninstall',packageName);}catch{}const installed=adb('install','-r',resolve(apk));assert.ok(installed.includes('Success'),'APK installation did not succeed');}
 const installedPackage=adb('shell','dumpsys','package',packageName);packageInfo={versionName:installedPackage.match(/versionName=(\S+)/)?.[1],versionCode:Number(installedPackage.match(/versionCode=(\d+)/)?.[1]),hostSha256:createHash('sha256').update(await readFile(hostExe)).digest('hex')};
 if(apk)packageInfo.apkSha256=createHash('sha256').update(await readFile(resolve(apk))).digest('hex');
 assert.equal(packageInfo.versionName,release.version);assert.equal(packageInfo.versionCode,release.androidVersionCode);
 if(process.env.NEXUS_QA_RESET==='1')adb('shell','pm','clear',packageName);
 adb('shell','settings','put','system','accelerometer_rotation','0');adb('shell','settings','put','system','user_rotation','0');
 adb('logcat','-c');adb('shell','am','start','-n',packageName+'/.MainActivity');
 if(resume){
  const previous=JSON.parse(await readFile(resolve(data,'network-live-result.json'),'utf8'));
  assert.equal(previous.version,release.version,'Cannot resume evidence from another release');
  hostPid=previous.hostPid;currentPort=previous.devicePort;roomId=previous.roomId;memberId=previous.memberId;permissions=previous.permissions;
  outcomes.push(...previous.outcomes.filter(item=>item.status==='passed'));platformObservations.push(...previous.platformObservations);await session();
  adb('shell','settings','put','secure','enabled_accessibility_services',packageName+'/.ControlService');adb('shell','settings','put','secure','accessibility_enabled','1');
  await until(async()=>{const peer=await online();return peer.permissions.control;},'same saved peer after isolated emulator recovery',20000);
 }else{
 await startHost(ports[0]);
 const room=await api('/api/rooms',{name:'v'+release.version+' network QA'});roomId=room.id;headers['X-Nexus-Room']=roomId;
 await record('real Android joins original PC endpoint and publishes permissions',async()=>{await join();assert.ok((await address()).endsWith(':'+ports[0]),'Android did not use original PC listener');await authorize();await screenshot('original-connected');});

 await record('old PC endpoint is unreachable; UDP rediscovers new address and port using the same member and permissions',async()=>{
  await stopHost();await startHost(ports[1]);
  const member=await online();assertMembership(member);const current=await address();assert.ok(current.endsWith(':'+ports[1]),'Android still displays old endpoint');assert.notEqual(current,'https://'+initialHost+':'+ports[0]);await screenshot('migrated-connected');
 });

 await record('paused new-member joining still permits saved-member recovery after app restart and another endpoint change',async()=>{
  await api('/api/room/access',{open:false});roomOpened=false;
  adb('shell','am','force-stop',packageName);await stopHost();await startHost(ports[2]);
  adb('shell','am','start','-n',packageName+'/.MainActivity');let member=await online();assertMembership(member,false);assert.equal((await findSwitch('远程控制')).checked,true,'App restart erased saved room control permission');
  if(!member.permissions.control){
   platformObservations.push({event:'Android 12 force-stop cleared the system accessibility-service grant',savedRoomControlPermission:true,recovery:'Regrant the system accessibility service; room membership and permissions remain saved.'});
   adb('shell','settings','put','secure','enabled_accessibility_services',packageName+'/.ControlService');adb('shell','settings','put','secure','accessibility_enabled','1');
   member=await until(async()=>{const peer=await online();return peer.permissions.control?peer:false;},'system accessibility regrant',15000);
  }
  assertMembership(member);assert.equal((await api('/api/state')).room.open,false);assert.ok((await address()).endsWith(':'+ports[2]));await screenshot('restarted-paused-connected');
 });
 }

 if(process.env.NEXUS_QA_WIFI_TOGGLE==='0'){
  outcomes.push({name:'Android virtual Wi-Fi off/on removes and restores the same room connection',status:'not_verified',reason:'MuMu guest ADB transport stopped when virtual Wi-Fi was disabled; this emulator cannot establish a completed Wi-Fi toggle result.'});
 }else{
 await record('Android virtual Wi-Fi off/on removes and restores the same room connection',async()=>{
  // MuMu's ADB transport can disappear with its virtual Wi-Fi. Schedule both
  // actions inside the guest so re-enabling never depends on a disconnected
  // host-to-guest command channel; poll the real PC connection concurrently.
  assert.ok(adb('shell','command -v setsid').endsWith('/setsid'),'Guest lacks detached Wi-Fi recovery command');
  adb('shell',"setsid sh -c 'sleep 45; svc wifi enable' >/sdcard/nexusroom-wifi-restore.log 2>&1 </dev/null &");
  const cycle=adbAsync('shell','svc','wifi','disable').then(()=>({ok:true}),error=>({error}));
  try{await offline();await cycle;}
  finally{try{adb('shell','svc','wifi','enable');}catch{}}
  await until(()=>/^Wifi is enabled/im.test(adb('shell','cmd','wifi','status')),'virtual Wi-Fi enabled',20000);const member=await online();assertMembership(member);await screenshot('wifi-restored');
 });
 }

 await record('revoked member is removed and cannot reconnect after app restart',async()=>{
  await api('/api/devices/'+memberId,undefined,'DELETE');await pause(1500);adb('shell','am','force-stop',packageName);adb('shell','am','start','-n',packageName+'/.MainActivity');await pause(6000);
  assert.equal((await api('/api/state')).devices.some(device=>device.id===memberId),false);const visible=nodes();assert.ok(visible.some(node=>node.text==='加入同一网络的工作空间'),'Android retained revoked room');await screenshot('revoked-clean');
 });

 // Leave an authenticated peer available for the parent's cross-feature QA.
 await api('/api/room/access',{open:true});roomOpened=true;await join();await authorize();assertMembership(await online());await screenshot('ready-for-feature-qa');
 const limited=outcomes.some(item=>item.status==='not_verified');await save(limited?'passed_with_environment_limit':'passed');console.log(outcomes.filter(item=>item.status==='passed').length+' real Android network checks passed'+(limited?'; Wi-Fi toggle not verified':'')+'; isolated host and peer left available at '+base);console.log('Sanitized evidence: '+resolve(data,'network-live-result.json'));
}catch(error){
 try{adb('shell','svc','wifi','enable');}catch{}
 await save('failed',error.message);console.error(error.message);console.error('Sanitized evidence: '+resolve(data,'network-live-result.json'));process.exitCode=1;
}
