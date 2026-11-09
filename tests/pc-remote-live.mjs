import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { chromium } from 'playwright';

// Real APK, Android UI and Windows desktop acceptance. Select the device explicitly.
// Public invitation/UI flows only; no encrypted Android vault or model keys are read.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = JSON.parse(await readFile(resolve(root, 'release.json'), 'utf8'));
const serial = process.env.NEXUS_QA_SERIAL;
assert.ok(serial, 'Set NEXUS_QA_SERIAL to the connected physical Android device or QA emulator');
const adbExe = process.env.NEXUS_QA_ADB || 'adb';
const host = process.env.NEXUS_REMOTE_HOST;
const apk = process.env.NEXUS_REMOTE_APK;
const mediaOnly = process.env.NEXUS_REMOTE_MEDIA_ONLY === '1';
const clipboardTest = process.env.NEXUS_REMOTE_CLIPBOARD === '1'; // Wrapper preserves the local clipboard in memory.
const nativeImeTest = process.env.NEXUS_REMOTE_NATIVE_IME === '1';
const evidence = resolve(process.env.NEXUS_REMOTE_EVIDENCE || resolve(root, '.local', 'v' + release.version.replaceAll('.', ''), 'pc-remote-live-' + Date.now()));
const uiPort = 19290, devicePort = 19291;
const endpoint = process.env.NEXUS_REMOTE_ENDPOINT || Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal && /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address.address))?.address;
assert.ok(endpoint, 'Set NEXUS_REMOTE_ENDPOINT to a reachable host address (127.0.0.1 for an existing ADB reverse tcp:19291)');
const base = 'http://127.0.0.1:' + uiPort;
const pause = ms => new Promise(done => setTimeout(done, ms));
const outcomes = [];
let child, fixture, browser, page, headers, roomId, deviceId, deviceInfo, status = 'failed', failure, hostLog = '', fixtureLog = '';
const fixtureLauncher = resolve(root, 'tests/fixtures/StartPcRemoteFixture.ps1');
await mkdir(evidence, { recursive: true });
const adb = (...args) => execFileSync(adbExe, ['-s', serial, ...args], { encoding: 'utf8', windowsHide: true, timeout: 90000, maxBuffer: 8*1024*1024 }).trim();
async function until(check, label, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { let result; try { result = await check(); } catch {} if (result) return result; await pause(350); }
  throw new Error('Timed out: ' + label);
}
async function api(path, body, method) {
  const response = await fetch(base + path, { method: method || (body === undefined ? 'GET' : 'POST'), headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(6000) });
  const value = await response.json(); assert.ok(response.ok, path + ' HTTP ' + response.status); return value;
}
function nodes() {
  adb('shell', 'uiautomator', 'dump', '/sdcard/nexusroom-pc-remote-qa.xml');
  const xml = adb('exec-out', 'cat', '/sdcard/nexusroom-pc-remote-qa.xml');
  const decode = s => s.replace(/&#(x[0-9a-f]+|\d+);/gi,(_,code)=>String.fromCodePoint(code[0].toLowerCase()==='x'?parseInt(code.slice(1),16):Number(code))).replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  return [...xml.matchAll(/<node\b[^>]*>/g)].map(([tag]) => {
    const attr = key => decode(tag.match(new RegExp('\\b' + key + '="([^"]*)"'))?.[1] || '');
    return { text: attr('text'), description: attr('content-desc'), class: attr('class'), package: attr('package'), bounds: (attr('bounds').match(/-?\d+/g) || []).map(Number), enabled: attr('enabled') === 'true', scrollable: attr('scrollable') === 'true' };
  }).filter(n => n.bounds.length === 4 && n.bounds[2] > n.bounds[0] && n.bounds[3] > n.bounds[1]);
}
async function tap(label, scroll = false) {
  for (let i = 0; i < (scroll ? 10 : 2); i++) {
    const tree = nodes(), node = tree.find(n => n.enabled && (n.text === label || n.description === label));
    if (node) { const [x1,y1,x2,y2] = node.bounds; adb('shell','input','tap',String(Math.round((x1+x2)/2)),String(Math.round((y1+y2)/2))); await pause(350); return node; }
    const container = tree.find(n => n.scrollable); if (!container) break;
    const [x1,y1,x2,y2] = container.bounds; const x = Math.round((x1+x2)/2);
    adb('shell','input','swipe',String(x),String(Math.round(y1+(y2-y1)*.8)),String(x),String(Math.round(y1+(y2-y1)*.25)),'250');
  }
  throw new Error('Android UI target not found: ' + label);
}
async function capture(name) {
  const path = '/sdcard/nexusroom-pc-' + name + '.png'; adb('shell','screencap','-p',path); adb('pull',path,resolve(evidence,name+'.png'));
  const tree = nodes(); await writeFile(resolve(evidence,name+'-ui.json'),JSON.stringify(tree,null,2));
}
const fixtureState = async () => {
  const snapshot = JSON.parse(await readFile(resolve(evidence,'fixture-state.json'),'utf8'));
  assert.equal(snapshot.pid, fixture?.pid, 'Windows snapshot belongs to this run\'s exact fixture process');
  return snapshot;
};
async function focusFixture() {
  execFileSync('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',resolve(root,'tests/fixtures/FocusFixture.ps1'),'-StateFile',resolve(evidence,'fixture-state.json'),'-Activate'],{encoding:'utf8',windowsHide:true,timeout:15000});
  await until(async()=>{const state=await fixtureState();return state.foreground&&state.foregroundPid===state.pid&&Date.now()-state.snapshotAt<500;},'safe fixture foreground');
}
async function findHorizontal(label,rowIndex=0,direction='left') {
  for(let attempt=0;attempt<16;attempt++){
    const tree=nodes(),found=tree.find(n=>n.text===label||n.description===label);
    if(found)return found;
    const row=tree.filter(n=>n.class==='android.widget.HorizontalScrollView'&&n.package==='com.nexusroom.android').at(rowIndex);assert.ok(row,'remote action row for '+label);
    const [x1,y1,x2,y2]=row.bounds,y=Math.round((y1+y2)/2),a=Math.round(x1+(x2-x1)*.85),b=Math.round(x1+(x2-x1)*.15);
    const left=(direction==='left')===(attempt<8);
    // A fast fling can skip a whole viewport on a physical phone. Drag slowly
    // enough that the next observed viewport overlaps the previous one.
    adb('shell','input','swipe',String(left?a:b),String(y),String(left?b:a),String(y),'800');await pause(350);
  }
  const finalMatch=nodes().find(n=>n.text===label||n.description===label);
  if(finalMatch)return finalMatch;
  throw new Error('Android action not found: '+label);
}
async function tapHorizontal(label,rowIndex=-1,direction='left') {
  const found=await findHorizontal(label,rowIndex,direction);assert.ok(found.enabled,'Android action is enabled: '+label);
  const [x1,y1,x2,y2]=found.bounds;adb('shell','input','tap',String(Math.round((x1+x2)/2)),String(Math.round((y1+y2)/2)));await pause(350);return found;
}
async function tapShortcut(label,direction='left') {
  const tree=nodes();
  if(tree.some(n=>n.text==='更多按键')||tree.filter(n=>n.class==='android.widget.HorizontalScrollView'&&n.package==='com.nexusroom.android').length<2)await tapTool('更多按键');
  return tapHorizontal(label,-1,direction);
}
const tapTool = (label,direction='left') => tapHorizontal(label,0,direction);
const desktopNode = () => nodes().find(n=>n.description.startsWith('电脑远程桌面；'));
async function rotateRemote(landscape) {
  const current=(await api('/api/state')).host.remote.session.sessionId;
  await tapTool(landscape?'横屏':'竖屏','right');
  await until(()=>{
    const tree=nodes(),view=tree.find(n=>n.description.startsWith('电脑远程桌面；'));
    return view&&tree.some(n=>n.text===(landscape?'竖屏':'横屏'))&&(landscape?(view.bounds[2]-view.bounds[0])>(view.bounds[3]-view.bounds[1]):(view.bounds[3]-view.bounds[1])>(view.bounds[2]-view.bounds[0]));
  },landscape?'landscape desktop layout':'portrait desktop layout');
  const remote=(await api('/api/state')).host.remote.session;
  assert.equal(remote.sessionId,current,'Rotation retains the approved session');assert.equal(remote.state,'streaming');
}
async function openDirectKeyboard() {
  await tapTool('手机键盘直接输入电脑','right');
  await until(()=>/mInputShown=true|isInputViewShown=true/.test(adb('shell','dumpsys','input_method')),'real Android keyboard is shown');
  assert.ok(!nodes().some(n=>n.description==='发送到电脑的文字输入框'),'Direct input uses the remote desktop instead of the intermediate editor');
}
async function hideDirectKeyboard() {
  const direct=nodes().find(n=>n.description==='手机键盘直接输入电脑');
  if(direct?.text==='收起手机键盘')await tapTool('手机键盘直接输入电脑','right');
}
async function directAscii(marker) {
  await desktopTap((await fixtureState()).textbox);await tapShortcut('Ctrl+A','right');
  await openDirectKeyboard();
  adb('shell','input','text',marker);
  await until(async()=> (await fixtureState()).text===marker,'direct hardware text reaches Windows without Send button');
}
async function changeGrant(permission,enabled) {
  const label={screen:'允许手机查看电脑画面',control:'允许手机鼠标与键盘操作',audio:'允许手机电脑播放声音',clipboard:'允许手机剪贴板传输'}[permission];
  const checkbox=page.getByRole('checkbox',{name:label,exact:true});
  if(await checkbox.isChecked()!==enabled)await checkbox.click();
  await until(async()=> (await api('/api/pc/remote/status')).permissions[permission]===enabled&&await checkbox.isChecked()===enabled,'Web saves '+permission+'='+enabled);
}
async function nativeImeCommit() {
  await desktopTap((await fixtureState()).textbox);await tapShortcut('Ctrl+A','right');await openDirectKeyboard();
  const inputMethodPackage=deviceInfo.defaultIme.split('/')[0];
  const keys=process.env.NEXUS_REMOTE_NATIVE_IME_KEYS?JSON.parse(process.env.NEXUS_REMOTE_NATIVE_IME_KEYS):[{label:'a'},{label:'b'},{label:'c'},{label:'空格'}];
  const expected=process.env.NEXUS_REMOTE_NATIVE_IME_EXPECTED||'abc ';
  assert.ok(Array.isArray(keys)&&keys.length>0&&keys.length<=100,'Provide a bounded JSON array of observed keyboard labels or coordinates');
  await capture('native-ime-before');
  for(const key of keys){
    const keyboard=nodes().filter(n=>n.package===inputMethodPackage);assert.ok(keyboard.length,'The current keyboard is present in the Android accessibility tree');
    let x,y;
    if(typeof key.label==='string'){
      const found=keyboard.find(n=>n.enabled&&(n.text===key.label||n.description===key.label));
      assert.ok(found,'Native keyboard key is not accessible: '+key.label+'. Supply NEXUS_REMOTE_NATIVE_IME_KEYS with coordinates observed from native-ime-before.png and NEXUS_REMOTE_NATIVE_IME_EXPECTED.');
      x=Math.round((found.bounds[0]+found.bounds[2])/2);y=Math.round((found.bounds[1]+found.bounds[3])/2);
    }else{
      assert.ok(Number.isInteger(key.x)&&Number.isInteger(key.y),'Observed native keyboard coordinates must be integers');x=key.x;y=key.y;
      assert.ok(keyboard.some(n=>x>=n.bounds[0]&&x<n.bounds[2]&&y>=n.bounds[1]&&y<n.bounds[3]),'Refuse coordinates outside the observed keyboard');
    }
    const before=await fixtureState();assert.equal(before.foregroundPid,before.pid);assert.ok(Date.now()-before.snapshotAt<1000);
    adb('shell','input','tap',String(x),String(y));await pause(250);
  }
  await until(async()=> (await fixtureState()).text.replaceAll('\r','')===expected,'actual system IME commits expected text into Windows');
  await capture('native-ime-committed');await hideDirectKeyboard();
}
async function supervisedNativeImeCommit() {
  await desktopTap((await fixtureState()).textbox);await tapShortcut('Ctrl+A','right');await openDirectKeyboard();
  assert.equal((await api('/api/pc/remote/status')).permissions.clipboard,false,'Actual IME input does not rely on clipboard authorization');
  const before=await fixtureState(),readyAt=Date.now(),resultFile=resolve(evidence,'native-ime-result.json');
  await capture('native-ime-ready');
  await writeFile(resolve(evidence,'native-ime-ready.json'),JSON.stringify({readyAt,resultFile,fixtureStateFile:resolve(evidence,'fixture-state.json'),textBefore:before.text,serial,defaultIme:deviceInfo.defaultIme,sessionId:(await api('/api/state')).host.remote.session.sessionId,clipboardPermission:false,instruction:'Use real system keyboard key taps and candidate selection. Record expectedText, composedNotForwarded and observed actions in resultFile after confirming the Windows fixture.'},null,2));
  console.log('NATIVE_IME_READY '+resolve(evidence,'native-ime-ready.json'));
  const result=await until(async()=>{const file=await stat(resultFile);if(file.mtimeMs<readyAt)return false;return JSON.parse(await readFile(resultFile,'utf8'));},'supervised real keyboard evidence in '+resultFile,300000);
  assert.ok(typeof result.expectedText==='string'&&result.expectedText.length>0&&result.expectedText.length<=8192,'The supervised result includes bounded expectedText');
  assert.equal(result.composedNotForwarded,true,'Supervised evidence must observe composition stays local until commit');
  assert.ok(Array.isArray(result.actions)&&result.actions.length>0,'The supervised result records actual system keyboard actions');
  const after=await fixtureState();assert.equal(after.foregroundPid,after.pid);assert.equal(after.text.replaceAll('\r',''),result.expectedText.replaceAll('\r',''));
  assert.equal((await api('/api/pc/remote/status')).permissions.clipboard,false);
  assert.ok(!nodes().some(n=>n.description==='发送到电脑的文字输入框'),'Native IME uses the remote desktop without an intermediate editor');
  await capture('native-ime-committed');await hideDirectKeyboard();
}
async function endedUi() {
  await until(()=>nodes().some(n=>n.description==='电脑远程控制状态'&&n.text.includes('请退出后重新请求')),'Android displays the ended session');
  const legacy=await findHorizontal('文字输入',0,'right'),direct=await findHorizontal('手机键盘直接输入电脑',0,'right');
  assert.equal(legacy.enabled,false);assert.equal(direct.enabled,false);
  const sound=await findHorizontal('电脑音频播放开关');assert.equal(sound.enabled,false);assert.equal(sound.text,'声音：静音');
  const exit=await findHorizontal('退出',0,'right');assert.equal(exit.enabled,true,'Exit remains available after session termination');
}
async function remotePoint(target, fx = .5, fy = .5) {
  const view = nodes().find(n => n.description.startsWith('电脑远程桌面；')), state = await fixtureState();
  assert.equal(state.foregroundPid, state.pid, 'Refuse remote input unless the QA fixture owns Windows focus');
  assert.equal(state.foreground, true, 'Refuse remote input into another Windows application');
  assert.ok(Date.now()-state.snapshotAt<1000,'Windows fixture snapshot is current');
  assert.ok(view, 'Native desktop canvas is visible');
  const [left,top,right,bottom] = view.bounds, width = right-left, height = bottom-top;
  const virtual = state.virtualScreen, scale = Math.min(width/virtual.width,height/virtual.height);
  return { x: Math.round(left+(width-virtual.width*scale)/2+(target.x+target.width*fx-virtual.x)*scale), y: Math.round(top+(height-virtual.height*scale)/2+(target.y+target.height*fy-virtual.y)*scale), view };
}
async function desktopTap(target) { const p = await remotePoint(target); adb('shell','input','tap',String(p.x),String(p.y)); await pause(700); }
async function check(name, action) { const start = Date.now(); await action(); outcomes.push({ name, status:'passed', seconds:Number(((Date.now()-start)/1000).toFixed(1)) }); console.log('PASS '+name); }
async function openRemote(approve = true) {
  await tap('远程控制电脑', true);
  const requested = await until(async () => { const state = await api('/api/state'); return state.host.remote?.session?.state === 'pending' && state.host.remote.session; }, 'real Android request pending');
  await page.getByRole('button',{name:approve?'允许本次电脑远程访问':'拒绝电脑远程访问',exact:true}).click();
  if (approve) {
    await until(async()=> (await api('/api/state')).host.remote?.session?.state==='streaming', 'real Android WSS streaming');
    await until(()=>adb('logcat','-d','-s','NexusRoom.PC:I').includes('JPEG decoded'), 'Android JPEG decoded');
  } else await until(async()=>!(await api('/api/state')).host.remote?.session,'request refused');
  return requested;
}
try {
  deviceInfo={manufacturer:adb('shell','getprop','ro.product.manufacturer'),model:adb('shell','getprop','ro.product.model'),androidVersion:adb('shell','getprop','ro.build.version.release'),sdk:Number(adb('shell','getprop','ro.build.version.sdk')),emulator:adb('shell','getprop','ro.kernel.qemu')==='1',defaultIme:adb('shell','settings','get','secure','default_input_method')};
  if (apk) assert.ok(adb('install','-r',resolve(apk)).includes('Success'),'formal APK installed');
  const info = adb('shell','dumpsys','package','com.nexusroom.android');
  assert.ok(info.includes('versionName='+release.version)); assert.ok(info.includes('versionCode='+release.androidVersionCode));
  adb('logcat','-c');
  child = spawn(host || 'dotnet', host ? ['--headless'] : [resolve(root,'src/NexusRoom.Host/bin/Debug/net10.0-windows/NexusRoom.Host.dll'),'--headless'], { cwd:root,windowsHide:true,env:{...process.env,NEXUS_DATA_DIR:resolve(evidence,'host-state'),NEXUS_UI_PORT:String(uiPort),NEXUS_DEVICE_PORT:String(devicePort),NEXUS_DISCOVERY_PORT:'19292',NEXUS_DISABLE_MDNS:'1'},stdio:['ignore','pipe','pipe'] });
  child.stdout.on('data',chunk=>{hostLog+=chunk}); child.stderr.on('data',chunk=>{hostLog+=chunk});
  await until(async()=> (await fetch(base+'/health')).ok,'QA host startup');
  const decrypt="Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($env:NEXUS_REMOTE_LAUNCH_FILE),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))";
  const launch=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',decrypt],{encoding:'utf8',windowsHide:true,env:{...process.env,NEXUS_REMOTE_LAUNCH_FILE:resolve(evidence,'host-state','launch.dat')}}).trim());
  headers={Authorization:'Bearer '+new URL(launch).hash.slice('#bootstrap='.length),'X-Nexus-Request':'1','Content-Type':'application/json'};
  roomId=(await api('/api/state')).room.id; headers['X-Nexus-Room']=roomId;
  await api('/api/room',{name:'v'+release.version+' Android PC remote QA'});
  const invite=await api('/api/invitation'); invite.server='https://'+endpoint+':'+devicePort;
  const url=new URL('nexusroom://join'); url.searchParams.set('payload',JSON.stringify(invite));
  adb('shell','am','start','--activity-clear-top','--activity-single-top','-a','android.intent.action.VIEW','-d',url.toString(),'-n','com.nexusroom.android/.MainActivity');
  await tap('加入房间',true); await tap('一致，加入');
  deviceId=(await until(async()=> (await api('/api/state')).devices.find(d=>d.online),'real room member online')).id;
  const member=(await api('/api/state')).devices.find(d=>d.id===deviceId); assert.equal(member.permissions.agent,false); assert.equal(member.permissions.control,false);
  browser=await chromium.launch({channel:'chrome',headless:true}); page=await browser.newPage({viewport:{width:1440,height:1100}}); await page.goto(launch);
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await check('PC grants start closed and are independent of Android Agent/control',async()=>{
    const permissions=(await api('/api/pc/remote/status')).permissions; assert.deepEqual(permissions,{screen:false,control:false,audio:false,clipboard:false});
    for(const [label,permission] of [['允许手机查看电脑画面','screen'],['允许手机鼠标与键盘操作','control'],['允许手机电脑播放声音','audio'],['允许手机剪贴板传输','clipboard']]){await page.getByRole('checkbox',{name:label,exact:true}).click();await until(async()=> (await api('/api/pc/remote/status')).permissions[permission]&&await page.getByRole('checkbox',{name:label,exact:true}).isChecked(),'Web saves '+permission);}
    await until(async()=>Object.values((await api('/api/pc/remote/status')).permissions).every(Boolean),'Web saves PC grants');
  });
  if(!mediaOnly){fixture=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',fixtureLauncher,'-EvidenceDirectory',evidence,'-Tone'],{windowsHide:true,encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']}));assert.ok(Number.isInteger(fixture.pid)&&fixture.pid>0&&/^\d+$/.test(fixture.startTimeTicks),'Fixture launcher returns an owned process identity');fixtureLog+=JSON.stringify(fixture)+'\n';await until(async()=> {const snapshot=await fixtureState();return snapshot.textbox&&snapshot.hwnd>0&&Date.now()-snapshot.snapshotAt<1000;},'real desktop fixture ready',45000);}
  await check('Android request can be refused from the actual Windows Web UI',async()=>{await openRemote(false);await capture('refused');await tap('退出');});
  await check('Android request approved locally streams actual Windows and reports working',async()=>{await openRemote();assert.equal((await api('/api/state')).host.activity,'working');await capture('desktop');});
  await check('Remote desktop is a modal accessible page',async()=>{const tree=nodes();assert.ok(tree.some(n=>n.description==='安卓远程控制电脑'));assert.ok(!tree.some(n=>n.description==='远程控制电脑'||n.description==='打开 Agent 悬浮窗'||n.text==='我的房间'),'Underlying room and Agent controls are hidden');});
  await check('Android landscape and portrait retain the locally approved remote session',async()=>{
    await rotateRemote(true);await capture('landscape');
    if(!mediaOnly){await focusFixture();const before=await fixtureState();await desktopTap(before.button);await until(async()=> (await fixtureState()).clicks>before.clicks,'landscape fitted touch reaches actual Windows button');}
    await rotateRemote(false);await capture('portrait-restored');
  });
  if(!mediaOnly){
  await focusFixture();
  await check('Android fitted desktop ignores its black bars',async()=>{
    const tree=nodes(),view=tree.find(n=>n.description.startsWith('电脑远程桌面；')),before=await fixtureState();assert.ok(view);
    const [left,top,right,bottom]=view.bounds,width=right-left,height=bottom-top,scale=Math.min(width/before.virtualScreen.width,height/before.virtualScreen.height);
    const bx=(width-before.virtualScreen.width*scale)/2,by=(height-before.virtualScreen.height*scale)/2;assert.ok(bx>10||by>10,'QA geometry has a letterbox');
    const x=Math.round(bx>10?left+5:(left+right)/2),y=Math.round(bx>10?(top+bottom)/2:top+5);
    adb('shell','input','tap',String(x),String(y));await pause(800);const after=await fixtureState();for(const key of ['clicks','rightClicks','down','up'])assert.equal(after[key],before[key],'black bar does not emit '+key);
  });
  await check('Android fitted desktop touch invokes actual Windows button',async()=>{const before=await fixtureState();await desktopTap(before.button);await until(async()=> (await fixtureState()).clicks>before.clicks,'Windows button clicked');});
  await check('Android long press invokes actual Windows right click',async()=>{const before=await fixtureState(),p=await remotePoint(before.panel);adb('shell','input','swipe',String(p.x),String(p.y),String(p.x),String(p.y),'850');await until(async()=> (await fixtureState()).rightClicks>before.rightClicks,'right mouse press');});
  await check('Android drag sends down/move/up to actual Windows',async()=>{const before=await fixtureState(),from=await remotePoint(before.panel,.2,.4),to=await remotePoint(before.panel,.75,.6);adb('shell','input','swipe',String(from.x),String(from.y),String(to.x),String(to.y),'600');await until(async()=>{const s=await fixtureState();return s.down>before.down&&s.up>before.up&&s.moves>before.moves},'mouse drag released');});
  await check('Android text field and editing shortcuts alter actual Windows text',async()=>{
    await desktopTap((await fixtureState()).textbox);await tapTool('文字输入','right');await tap('发送到电脑的文字输入框');adb('shell','input','text','Android_keyboard_input');assert.equal((await fixtureState()).foreground,true);await tap('发送文字');await until(async()=> (await fixtureState()).text==='Android_keyboard_input','mobile input reaches Windows');
    await tap('收起键盘');await tapShortcut('Backspace','right');await until(async()=> (await fixtureState()).text==='Android_keyboard_inpu','mobile backspace reaches Windows');await tapShortcut('Ctrl+A');await tapTool('文字输入','right');await tap('发送到电脑的文字输入框');adb('shell','input','text','Replaced_keyboard_text');await tap('发送文字');await until(async()=> (await fixtureState()).text==='Replaced_keyboard_text','selection replaced');await tap('收起键盘');await capture('input');
  });
  await check('Android scroll shortcut reaches actual Windows wheel',async()=>{const before=await fixtureState();await desktopTap(before.panel);await tapTool('滚动↓');await until(async()=> (await fixtureState()).wheel<before.wheel,'mobile wheel input');});
  if(clipboardTest)await check('Explicit clipboard and Android Unicode multiline editor reach Windows',async()=>{
    const marker='安卓输入验证 🚀\n第二行测试文字';execFileSync('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',resolve(root,'tests/fixtures/PcClipboardFixture.ps1'),'-FromEnvironment'],{windowsHide:true,env:{...process.env,NEXUS_FIXTURE_CLIPBOARD_TEXT:Buffer.from(marker,'utf8').toString('base64')}});await tapShortcut('复制电脑剪贴板');
    await desktopTap((await fixtureState()).textbox);await tapShortcut('Ctrl+A','right');await tapTool('文字输入','right');await tap('发送到电脑的文字输入框');adb('shell','input','keyevent','KEYCODE_PASTE');
    await until(()=>nodes().some(n=>n.description==='发送到电脑的文字输入框'&&n.text.replaceAll('\r','')===marker),'Android Unicode paste');
    await tap('发送文字');await until(async()=> (await fixtureState()).text.replaceAll('\r','')===marker,'Unicode multiline arrives at Windows');await tap('收起键盘');
    await tapShortcut('发送手机剪贴板');await until(()=>nodes().some(n=>n.description==='电脑远程控制状态'&&n.text==='手机文本已发送到电脑剪贴板'),'phone clipboard set acknowledged');await capture('unicode');
  });
  await check('Android direct keyboard sends hardware text and edits without the intermediate field',async()=>{
    await directAscii('Direct_keyboard_text');adb('shell','input','keyevent','KEYCODE_DEL');await until(async()=> (await fixtureState()).text==='Direct_keyboard_tex','direct hardware Backspace');
    await capture('direct-keyboard');await hideDirectKeyboard();
  });
  await check('Direct keyboard remains usable above the landscape desktop',async()=>{
    await rotateRemote(true);await directAscii('Landscape_keyboard_text');
    const view=desktopNode();assert.ok(view,'Remote desktop remains visible while the landscape keyboard is open');assert.ok(view.bounds[2]-view.bounds[0]>100&&view.bounds[3]-view.bounds[1]>80,'Remote desktop retains a useful area above the keyboard');
    await capture('landscape-keyboard');await hideDirectKeyboard();await rotateRemote(false);
  });
  }
  await check('Android explicitly enables real Windows audio playback',async()=>{
    await tapTool('电脑音频播放开关');await until(()=>adb('logcat','-d','-s','NexusRoom.PC:I').includes('First desktop PCM playback accepted:'),'AudioTrack receives PCM',18000);await writeFile(resolve(evidence,'audio-flinger.txt'),adb('shell','dumpsys','media.audio_flinger'));await capture('audio');
  });
  await check('Actual local stop releases PC ownership and Android session',async()=>{await page.getByRole('button',{name:'结束电脑远程共享',exact:true}).click();await until(async()=> (await api('/api/state')).host.activity==='online'&&!(await api('/api/state')).host.remote.session,'PC idle after local stop');await endedUi();await capture('local-stop');await tap('退出');});
  if(!mediaOnly){
  await check('View-only Android sessions cannot open either keyboard or alter Windows',async()=>{
    await changeGrant('control',false);await changeGrant('clipboard',false);await openRemote();await focusFixture();
    const tree=nodes(),direct=tree.find(n=>n.description==='手机键盘直接输入电脑'),legacy=tree.find(n=>n.text==='文字输入');
    assert.ok(direct&&!direct.enabled,'Direct keyboard is disabled without control permission');assert.ok(legacy&&!legacy.enabled,'Intermediate editor is disabled without control permission');
    const before=await fixtureState();await desktopTap(before.button);adb('shell','input','text','View_only_must_not_type');await pause(700);
    const after=await fixtureState();assert.equal(after.clicks,before.clicks);assert.equal(after.text,before.text);await capture('view-only');await tapTool('退出','right');
    await until(async()=> !(await api('/api/state')).host.remote.session,'view-only session released');
  });
  await check('Direct Android keyboard works with clipboard permission disabled',async()=>{
    await changeGrant('control',true);await openRemote();await focusFixture();assert.equal((await api('/api/pc/remote/status')).permissions.clipboard,false);
    await directAscii('No_clipboard_direct_input');await capture('direct-no-clipboard');await hideDirectKeyboard();
  });
  if(nativeImeTest)await check('Actual installed Android IME commits without intermediate editor or clipboard permission',process.env.NEXUS_REMOTE_NATIVE_IME_KEYS?nativeImeCommit:supervisedNativeImeCommit);
  await check('Closing a direct-input session releases ownership before a new request',async()=>{
    await tapTool('退出','right');
    await until(async()=> !(await api('/api/state')).host.remote.session,'no-clipboard session released');await changeGrant('clipboard',true);
  });
  }
  await check('Android backgrounding stops a new remote session without replay',async()=>{await openRemote();adb('shell','input','keyevent','KEYCODE_HOME');await until(async()=> (await api('/api/state')).host.activity==='online'&&!(await api('/api/state')).host.remote.session,'Android pause releases PC');});
  await check('PC permission revocation terminates actual Android WSS',async()=>{adb('shell','am','start','--activity-clear-top','--activity-single-top','-n','com.nexusroom.android/.MainActivity');await openRemote();await page.getByRole('checkbox',{name:'允许手机鼠标与键盘操作',exact:true}).click();await until(async()=> !(await api('/api/pc/remote/status')).permissions.control&&(await api('/api/state')).host.activity==='online'&&!(await api('/api/state')).host.remote.session,'revocation terminates active stream');await endedUi();await capture('revoked');await tap('退出');});
  status='passed';
} catch(error) {failure=error.stack;console.error(error.message);try{await capture('failure')}catch{} }
finally {
  try{if(roomId)await api('/api/pc/remote/stop',{});}catch{}
  try{if(roomId)await api('/api/rooms/'+roomId,undefined,'DELETE');}catch{}
  await browser?.close();
  if(fixture)try{execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',fixtureLauncher,'-Stop','-ProcessId',String(fixture.pid),'-StartTimeTicks',fixture.startTimeTicks],{windowsHide:true,timeout:10000,stdio:['ignore','ignore','pipe']});}catch(error){fixtureLog+='Owned fixture cleanup failed: '+(error.stderr?.toString()||error.message)+'\n';status='failed';failure=failure||'Owned desktop fixture cleanup failed';}
  child?.kill();
  await writeFile(resolve(evidence,'host.log'),hostLog);await writeFile(resolve(evidence,'fixture.log'),fixtureLog);
  const digest=async path=>createHash('sha256').update(await readFile(resolve(path))).digest('hex');
  const platform=deviceInfo?.emulator?'Android emulator':'Physical Android device';
  const transport=endpoint==='127.0.0.1'||endpoint==='localhost'?'ADB reverse':'LAN';
  await writeFile(resolve(evidence,'result.json'),JSON.stringify({version:release.version,androidVersionCode:release.androidVersionCode,status,error:failure,serial,device:deviceInfo,endpoint,transport,roomId,deviceId,mediaOnly,clipboardTest,nativeImeTest,apkSha256:apk?await digest(apk):undefined,hostExeSha256:host?await digest(host):undefined,hostDllSha256:host?await digest(resolve(dirname(host),'NexusRoom.Host.dll')):undefined,outcomes,time:new Date().toISOString(),scope:mediaOnly?`${platform} UI, authenticated TLS/WSS via ${transport}, desktop decode, rotation, AudioTrack playback and lifecycle only; no Windows input assertions.`:`${platform} UI, authenticated TLS/WSS via ${transport}, actual Windows fixture input, rotation, direct hardware text, permissions and AudioTrack playback.${nativeImeTest?' Actual installed IME key taps and commits included.':' Actual installed IME composition and Chinese/emoji typing are not asserted by ADB hardware text.'} ${transport==='ADB reverse'?'Physical Wi-Fi is not represented. ':''}UAC secure desktop and DRM apps are not represented.`},null,2));
}
assert.equal(status,'passed',failure);console.log('PASS live Android PC remote acceptance: '+evidence);
