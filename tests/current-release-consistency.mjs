import { projectPath } from '../scripts/submission-paths.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = name => readFile(projectPath(root, name), 'utf8');
const json = async name => JSON.parse(await read(name));
const release = await json('release.json');
const checks = [];
const observations = [];
async function check(name, action) { await action(); checks.push({ name, status: 'passed' }); console.log('PASS ' + name); }
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function csv(body) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i=0;i<body.length;i++) {
    const c=body[i];
    if (c==='"') { if (quoted && body[i+1]==='"') {cell+='"';i++;} else quoted=!quoted; }
    else if (!quoted && c===',') {row.push(cell);cell='';}
    else if (!quoted && c==='\n') {row.push(cell.replace(/\r$/, ''));rows.push(row);row=[];cell='';}
    else cell+=c;
  }
  if (cell || row.length) {row.push(cell.replace(/\r$/, ''));rows.push(row);}
  const headers=rows.shift();return rows.filter(row=>row.length===headers.length).map(row=>Object.fromEntries(headers.map((key,i)=>[key,row[i]])));
}
await check('release version agrees across Host, Web, npm lock, Android and issue template', async () => {
  assert.equal((await read('src/NexusRoom.Host/NexusRoom.Host.csproj')).match(/<Version>([^<]+)<\/Version>/)?.[1],release.version);
  for (const name of ['src/NexusRoom.Web/package.json','src/NexusRoom.Web/package-lock.json']) assert.equal((await json(name)).version, release.version);
  const gradle=await read('android/app/build.gradle');
  assert.equal(gradle.match(/versionName '([^']+)'/)?.[1],release.version);
  assert.equal(Number(gradle.match(/versionCode (\d+)/)?.[1]),release.androidVersionCode);
  assert.ok((await read('.github/ISSUE_TEMPLATE/bug_report.yml')).includes(`placeholder: ${release.version} / ${release.androidVersionCode}`));
});
await check('all eight offline model files retain their declared size and SHA-256', async () => {
  const models=await json('config/voice-models.json');
  assert.equal(models.models.length,8);
  for (const model of models.models) {
    const bytes=await readFile(projectPath(root,model.source));assert.equal(bytes.length,model.bytes);assert.equal(sha(bytes),model.sha256);
  }
});
if (!process.argv.includes('--source-only')) {
await check('measured task, permission and request-mode totals reconcile with the public tables', async () => {
  const evidence=await json('tests/results/audit/final_execution_status.json');
  const agent=csv(await read('tests/results/tables/agent_primary_results.csv'));
  const boundaries=csv(await read('tests/results/tables/T03_Boundary_Acceptance.csv'));
  const consent=csv(await read('tests/results/tables/live_boundary_cases.csv'));
  assert.equal(agent.length,evidence.primary_agent.instances);
  assert.equal(agent.filter(row=>row.verified_success==='True').length,evidence.primary_agent.independently_verified);
  assert.equal(boundaries.filter(row=>row.status==='PASS').length,evidence.deterministic_boundary.passed);
  assert.equal(consent.filter(row=>row.status==='PASS').length,evidence.actual_request_mode.passed);
});
await check('measured tables, quantitative figures and experiment inputs retain their SHA-256', async () => {
  const measurements=await json('tests/results/audit/measurement-manifest.json');
  assert.equal(measurements.version,release.version);
  assert.ok(measurements.files.length >= 40);
  for (const entry of measurements.files) {
    const path=projectPath(root,measurements.base,entry.path);
    assert.ok((await stat(path)).isFile());
    const bytes=await readFile(path);assert.equal(bytes.length,entry.bytes);assert.equal(sha(bytes),entry.sha256,entry.path);
  }
});
await check('historical report metadata and recorded physical APK evidence remain internally consistent', async () => {
  const validation=await json('tests/results/audit/current-validation.json');
  assert.equal(validation.version,release.version);assert.equal(validation.androidVersionCode,release.androidVersionCode);
  const phone=await json('tests/results/audit/current-android-smoke.json');
  assert.equal(phone.version,release.version);assert.equal(phone.androidVersionCode,release.androidVersionCode);
  const deliveredSha256=sha(await readFile(projectPath(root,'artifacts',`NexusRoom-Android-${release.version}.apk`)));
  const recordedSha256=phone.device.apkSha256;
  const archived=await json('tests/results/audit/current-artifacts.json');
  assert.equal(recordedSha256,archived.android.sha256,'Historical physical smoke record differs from its recorded artifact identity');
  observations.push({kind:'historical_android_binary_provenance',recordedSha256,deliveredSha256,sameBinary:recordedSha256===deliveredSha256,scope:'A differing delivered binary does not inherit the archived physical-device test acceptance.'});
  assert.equal(phone.status,'passed');assert.equal(phone.checks.length,8);assert.ok(phone.checks.every(check=>check.status==='passed'));
});
}
const result={schemaVersion:1,version:release.version,androidVersionCode:release.androidVersionCode,status:observations.some(item=>item.sameBinary===false)?'passed_with_historical_binary_difference':'passed',checks,observations};
if(process.env.NEXUS_CONSISTENCY_OUTPUT) {
  const output=resolve(process.env.NEXUS_CONSISTENCY_OUTPUT);await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify(result,null,2)+'\n');
}
for (const item of observations) if (!item.sameBinary) console.log('NOTICE historical Android test APK differs from the delivered APK; archived hardware acceptance does not apply to the delivered bytes.');
console.log(`${checks.length} release declaration and historical evidence consistency checks passed.`);
