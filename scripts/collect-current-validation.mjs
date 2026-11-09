import { projectPath, generatedEvidencePath } from './submission-paths.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
const root=resolve(import.meta.dirname,'..');
const args=Object.fromEntries(process.argv.slice(2).reduce((pairs,value,i,all)=>i%2===0?[...pairs,[value.replace(/^--/,''),all[i+1]]]:pairs,[]));
assert.equal(args['build-exit-code'],'0','Record a successfully completed build/regression command');
const logDir=resolve(args.logs || projectPath(root,'.local/documentation-sync'));
const release=JSON.parse(await readFile(projectPath(root,'release.json'),'utf8'));
const logs={};for(const name of ['build-regression','workspace-ui','ui','native-presentation'])logs[name]=await readFile(join(logDir,name+'.log'),'utf8');
const suites=[];
function suite(id,name,command,pattern,checks,method,log='build-regression') {
  assert.match(logs[log],pattern,id+' completion missing');
  suites.push({id,name,command,status:'passed',checks,method});
}
suite('build','Web / Windows / Android build and lint','scripts/build.ps1 -SkipPackage',/BUILD SUCCESSFUL/,null,'TypeScript/Vite, .NET build, Android debug/release compilation and lint');
for(const [id,name,command,pattern,checks,method] of [
  ['integration','Host integration','tests/integration.mjs',/41 integration checks passed/,41,'Isolated actual Host; virtual Android peers'],
  ['host','Host regression','tests/host-regression.mjs',/regression: 12 checks passed/,12,'Actual Host and isolated state'],
  ['pc-agent','PC Agent contract','tests/pc-agent-contract.mjs',/10 PC contract checks passed/,10,'Actual per-task bridge with protocol fixture'],
  ['room-files','PC room files','tests/pc-room-files-contract.mjs',/13 PC room-file contract checks passed/,13,'Actual Host transfer checks; fixture phone and Harness'],
  ['remote-ui','PC remote consent UI','tests/pc-remote-ui.mjs',/PASS Web 1\.0\.0:/,null,'Production React UI and bounded API fixtures'],
  ['voice-room','Voice room endpoints','tests/voice-room.mjs',/Room voice: 12 checks passed/,12,'Actual Host, TLS/WSS, idempotency and fixture Agent RPC'],
  ['voice-ui','Voice input and wake UI','tests/voice-ui.mjs',/PASS voice UI: 15 executable/,15,'Production React; controlled voice API responses'],
  ['units','Agent, runtime and media units','node --test tests/pc-harness-policy.test.mjs tests/pc-room-files.test.mjs tests/communication-rtc.test.mjs tests/runtime-path.test.mjs',/tests 28[\s\S]*?pass 28[\s\S]*?fail 0/,28,'Budget, tools, paths and asynchronous media lifecycle'],
  ['exe-format','EXE archive format','node --test tests/single-exe-format.test.mjs',/tests 2[\s\S]*?pass 2[\s\S]*?fail 0/,2,'Malformed payload and path-integrity cases'],
  ['communication','Communication contract','tests/communication-contract.mjs',/Communication contract: 14 checks passed/,14,'Actual pinned TLS/WSS and both task bridges'],
  ['communication-ui','Communication UI / RTP','tests/communication-ui.mjs',/12 authenticated communication UI\/RTP checks passed/,12,'Controlled browser media peers'],
  ['voice-core','Voice arbitration and intent','dotnet run --project tests/voice/VoiceTests.csproj',/Voice core: 31 checks passed/,31,'Production coordinator, ledger and candidate validation'],
  ['identity','Android room identity','tests/android-room-identity.ps1',/8 real HTTPS identity regression checks passed/,8,'Production Java over real HTTPS fixture endpoints'],
  ['room-session','Android room sessions','tests/android-room-session.ps1',/20 production room session regression checks passed/,20,'Production Java lifecycle fixtures'],
  ['android-media','Android media lifecycle','tests/android-room-session.ps1',/12 production communication lifecycle checks passed/,12,'Production Java media and callback lifecycle fixtures'],
  ['viewport','Android PC viewport / IME','tests/android-pc-viewport.ps1',/Android direct IME:.*passed\./,null,'Production viewport and IME JVM assertions'],
  ['single-exe','Standalone Windows EXE','tests/windows-single-exe.ps1',/PASS single Windows EXE: 3 cases/,3,'Corruption rejection, cold extraction and state reuse'],
])suite(id,name,command,pattern,checks,method);
suite('workspace','PC workspace browsing UI','tests/workspace-ui.mjs',/PASS Windows files\/folders\/details\/search\/selection/,null,'Production UI; files, search, details, selection and narrow layout','workspace-ui');
suite('floating-ui','Agent floating UI','tests/ui.mjs',/PASS page identity, meaningful render/,null,'Actual isolated Host; drag, reopen, draft and output bounds','ui');
suite('native','Windows voice and foreground presentation','scripts/verify-voice-native.ps1 -Microphone -Presentation',/"presentation":"passed"/,null,'Native KWS/ASR, real microphone and minimized WinForms restoration','native-presentation');
const phone=JSON.parse(await readFile(projectPath(root,'tests/results/audit/current-android-smoke.json'),'utf8'));
assert.equal(phone.status,'passed');
suites.push({id:'physical-android',name:'Signed APK on physical Android',command:'NEXUS_QA_SERIAL=<USB serial> node tests/current-android-smoke.mjs',status:'passed',checks:phone.checks.length,method:phone.method,date:phone.date});
const lint={};
for(const variant of ['debug','release']) {
  const xml=await readFile(join(resolve(args['lint-dir']),'lint-results-'+variant+'.xml'),'utf8');
  lint[variant]={errors:(xml.match(/severity="Error"/g)||[]).length,warnings:(xml.match(/severity="Warning"/g)||[]).length,issues:[...xml.matchAll(/<issue\s[^>]*id="([^"]+)"[^>]*severity="([^"]+)"/g)].map(match=>({id:match[1],severity:match[2]}))};
  assert.equal(lint[variant].errors,0);
}
const sourceFiles=[];
async function walk(directory) {
 for(const entry of await readdir(directory,{withFileTypes:true})) {
  const path=join(directory,entry.name);
  if(entry.isDirectory()) {if(!['node_modules','bin','obj','build','wwwroot','.gradle','dist','results'].includes(entry.name))await walk(path);}
  else if(/\.(cs|java|ts|tsx|mjs|ps1|py|json|xml|gradle)$/.test(entry.name)) {
   const bytes=await readFile(path);sourceFiles.push({path:relative(root,path).replaceAll('\\','/'),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
 }
}
for (const directory of ['src','android','scripts','tests','config']) await walk(projectPath(root,directory));
await walk(projectPath(root,'tests/results/code'));
sourceFiles.sort((a,b)=>a.path.localeCompare(b.path,'en'));
const result={schemaVersion:1,date:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date()),timezone:'Asia/Shanghai',version:release.version,androidVersionCode:release.androidVersionCode,status:'passed',buildExitCode:0,suites,androidLint:lint,logDigests:Object.fromEntries(Object.entries(logs).map(([name,body])=>[name,createHash('sha256').update(body).digest('hex')])),sourceFiles,followUp:['Physical simultaneous Hi Nexus with both microphones and measured background noise','Locked-screen and OEM background-listening endurance','Per-direction physical acoustic media with documented speaker/headphone settings','Repeated provider/model task matrix and optional ST06/ST07 sustained loads']};
await mkdir(resolve(args.output ? resolve(args.output) : generatedEvidencePath(root,'current-validation.json'),'..'),{recursive:true});
await writeFile(args.output ? resolve(args.output) : generatedEvidencePath(root,'current-validation.json'),JSON.stringify(result,null,2)+'\n');
console.log(`PASS current validation collection: ${suites.length} suite entries; Android lint ${lint.debug.warnings}/${lint.release.warnings} warnings.`);
