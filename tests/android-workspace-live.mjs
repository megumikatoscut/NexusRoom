import { projectPath } from '../scripts/submission-paths.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

// Real Android UI acceptance on a disposable, explicitly selected emulator.
// No Android room-vault reads, app resets, Host restarts, or secret-bearing logs.
const usage = [
  'Usage: node tests/android-workspace-live.mjs [--ui-only] [--task-only] [--regression-only] [--lifecycle-only] [--room-action-only]',
  '',
  'Required: NEXUS_QA_SERIAL, NEXUS_WORKSPACE_LAUNCH_FILE (or NEXUS_LIVE_LAUNCH_FILE)',
  'Optional: NEXUS_WORKSPACE_ROOM_ID, NEXUS_WORKSPACE_DEVICE_ID, NEXUS_QA_ADB,',
  '          NEXUS_WORKSPACE_EVIDENCE, NEXUS_WORKSPACE_PC_NAME, NEXUS_WORKSPACE_APK',
  '',
  'Model task: select NEXUS_WORKSPACE_PROFILE_ID, or set NEXUS_WORKSPACE_MODEL_STATE',
  'to an authorized local DPAPI state.dat. NEXUS_WORKSPACE_MODEL defaults to deepseek-flash.',
  'Imported model keys stay in process pipes/memory and the QA Host encrypted storage;',
  'only a temporary QA profile is created, then removed. --ui-only skips the model task.',
  'Default scope includes temporary Android joins and room dissolution while a picker or Agent permission dialog is open.',
  'Set NEXUS_WORKSPACE_LIFECYCLE=0 only when running a narrower acceptance pass.',
  '--task-only verifies the real PC task and lifecycle scenarios using NEXUS_WORKSPACE_CWD already chosen in the app.',
  '--regression-only checks file details/pause, two real PC tasks and latest-result ordering, then lifecycle using that cwd.',
  '--lifecycle-only verifies just room dissolution; set NEXUS_WORKSPACE_CWD to a previously chosen QA directory.',
  '--room-action-only verifies just stale permission-dialog dismissal with the same cwd precondition.',
  '',
  'Run only after the emulator UI owner has handed off control. The APK must already be installed.',
  'Evidence contains UI screenshots, safe UI trees and a sanitized result JSON under .local.'
].join('\n');
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(usage);
  process.exit(0);
}
for (const option of process.argv.slice(2)) {
  if (!['--ui-only', '--task-only', '--regression-only', '--lifecycle-only', '--room-action-only'].includes(option)) throw new Error('Unknown option: ' + option);
}
const taskOnly = process.argv.includes('--task-only');
const regressionOnly = process.argv.includes('--regression-only');
const lifecycleOnly = process.argv.includes('--lifecycle-only');
const roomActionOnly = process.argv.includes('--room-action-only');
assert.ok([taskOnly, regressionOnly, lifecycleOnly, roomActionOnly].filter(Boolean).length <= 1, 'Choose only one narrow acceptance mode');
assert.ok(!((taskOnly || regressionOnly) && process.argv.includes('--ui-only')), 'Task acceptance needs an authorized model task');
const narrowLifecycle = lifecycleOnly || roomActionOnly;
const narrowAcceptance = taskOnly || regressionOnly || narrowLifecycle;
const uiOnly = process.argv.includes('--ui-only') || narrowLifecycle;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = JSON.parse(await readFile(projectPath(root, 'release.json'), 'utf8'));
const versionTag = 'v' + release.version.replaceAll('.', '');
const serial = process.env.NEXUS_QA_SERIAL;
const launchFile = process.env.NEXUS_WORKSPACE_LAUNCH_FILE || process.env.NEXUS_LIVE_LAUNCH_FILE;
if (!serial || !launchFile) throw new Error('NEXUS_QA_SERIAL and a QA launch.dat path are required. Use --help.');
const adbExe = process.env.NEXUS_QA_ADB || 'adb';
const evidence = resolve(process.env.NEXUS_WORKSPACE_EVIDENCE || projectPath(root, '.local', 'android-workspace-live-' + Date.now()));
const fixture = resolve(evidence, 'PC 文件夹测试');
const workspace = resolve(process.env.NEXUS_WORKSPACE_CWD || resolve(fixture, 'qa 工作 目录'));
const otherWorkspace = resolve(fixture, 'other 其他 目录');
const nestedWorkspace = resolve(workspace, 'nested 子目录');
let marker = `NEXUSROOM_${versionTag.toUpperCase()}_ANDROID_PC_OK_` + Date.now();
const markerName = `android-to-pc-${versionTag}.txt`;
const fileFixtures = [
  { name: `${versionTag}-中文 notes.txt`, bytes: Buffer.from('NexusRoom 中文文件\n'), type: 'TXT 文件' },
  { name: `${versionTag}-空文件.bin`, bytes: Buffer.alloc(0), type: 'BIN 文件' },
  { name: `${versionTag}-image.png`, bytes: Buffer.from([137, 80, 78, 71]), type: 'PNG 文件' },
  { name: `${versionTag}-document.pdf`, bytes: Buffer.from('%PDF-1.7\n'), type: 'PDF 文件' },
  { name: `${versionTag}-archive.zip`, bytes: Buffer.from([80, 75, 3, 4]), type: 'ZIP 文件' },
  { name: `${versionTag}-LICENSE`, bytes: Buffer.from('QA fixture\n'), type: '无扩展名文件' }
];
const packageName = 'com.nexusroom.android';
const officialApk = resolve(process.env.NEXUS_WORKSPACE_APK || projectPath(root, 'artifacts', `NexusRoom-Android-${release.version}.apk`));
const pcName = process.env.NEXUS_WORKSPACE_PC_NAME || process.env.COMPUTERNAME;
assert.ok(pcName, 'NEXUS_WORKSPACE_PC_NAME or COMPUTERNAME must identify the PC menu row');
const pause = ms => new Promise(done => setTimeout(done, ms));
const outcomes = [];
const acceptedTasks = [];
const secrets = [];
const temporaryMembers = [];
let base, headers, roomId, memberId, roomName, phoneName, originalPcEnabled, originalDefaultProfile, importedProfile, temporaryRoom;
let acceptedRun, activeRunId, modelProfile, phoneEndpoint, status = 'failed', failure;
let apkSha256;

function redact(value) {
  let text = String(value || '');
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[redacted]');
  return text.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/#bootstrap=[^\s"'<>]+/g, '#bootstrap=[redacted]')
    .slice(0, 1200);
}
function decrypt(file, profileModel) {
  const script = profileModel
    ? 'Add-Type -AssemblyName System.Security; $s = [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($env:NEXUS_WORKSPACE_READ_FILE),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)) | ConvertFrom-Json; $p = @($s.rooms | ForEach-Object { $_.agentProfiles } | Where-Object { $_.model -eq $env:NEXUS_WORKSPACE_READ_MODEL -and $_.apiKey }) | Select-Object -First 1; if ($null -eq $p) { exit 2 }; $p | Select-Object name,apiType,apiUrl,model,apiKey,maxCalls,maxSteps,timeoutSeconds | ConvertTo-Json -Compress'
    : 'Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($env:NEXUS_WORKSPACE_READ_FILE),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))';
  try {
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, NEXUS_WORKSPACE_READ_FILE: resolve(file), NEXUS_WORKSPACE_READ_MODEL: profileModel || '' }
    }).trim());
  } catch { throw new Error('Unable to read the authorized QA DPAPI ' + (profileModel ? 'model' : 'launch') + ' data'); }
}
function adb(...args) {
  try {
    return execFileSync(adbExe, ['-s', serial, ...args], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000
    }).trim();
  } catch { throw new Error('ADB ' + args.slice(0, 2).join(' ') + ' failed on ' + serial); }
}
async function api(path, body, method, selectedRoom = roomId) {
  const requestHeaders = { ...headers };
  if (selectedRoom) requestHeaders['X-Nexus-Room'] = selectedRoom;
  const response = await fetch(base + path, {
    method: method || (body === undefined ? 'GET' : 'POST'), headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000)
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(path + ' HTTP ' + response.status + ': ' + redact(value?.title || 'request failed'));
  return value;
}
async function until(check, label, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await pause(400);
  }
  throw new Error('Timed out: ' + label);
}
function tree() {
  adb('shell', 'uiautomator', 'dump', '/sdcard/nexusroom-workspace-live.xml');
  const xml = adb('exec-out', 'cat', '/sdcard/nexusroom-workspace-live.xml');
  const decode = value => value.replace(/&(quot|apos|lt|gt|amp|#x[0-9a-f]+|#\d+);/gi, (_, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1].toLowerCase() === 'x';
      return String.fromCodePoint(parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10));
    }
    return { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' }[entity.toLowerCase()];
  });
  const nodes = [...xml.matchAll(/<node\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/g)].map(([tag]) => {
    // Android's XML serializer chooses single quotes for text containing JSON.
    // Decode either quote style once so literal entity text stays literal.
    const attributes = Object.fromEntries([...tag.matchAll(/([\w-]+)=(["'])(.*?)\2/gs)]
      .map(match => [match[1], decode(match[3])]));
    const attr = name => attributes[name] || '';
    return { text: attr('text'), description: attr('content-desc'), class: attr('class'),
      enabled: attr('enabled') === 'true', scrollable: attr('scrollable') === 'true',
      checked: attr('checked') === 'true', bounds: (attr('bounds').match(/\d+/g) || []).map(Number) };
  }).filter(node => node.bounds.length === 4);
  return { xml, nodes };
}
function center(node) {
  const [x1, y1, x2, y2] = node.bounds;
  return [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)];
}
function tapNode(node) { adb('shell', 'input', 'tap', ...center(node).map(String)); }
function swipe(container, toTop = false) {
  const [x1, y1, x2, y2] = container.bounds;
  const x = Math.round(x1 + (x2 - x1) * .55);
  const top = Math.round(y1 + (y2 - y1) * .22), bottom = Math.round(y1 + (y2 - y1) * .82);
  adb('shell', 'input', 'swipe', String(x), String(toTop ? top : bottom), String(x), String(toTop ? bottom : top), '240');
}
const matches = (node, label) => typeof label === 'function' ? label(node)
  : node.text.toLocaleLowerCase() === label.toLocaleLowerCase() || node.description.toLocaleLowerCase() === label.toLocaleLowerCase();
async function visible(label, timeout = 20000) {
  return until(() => tree().nodes.find(node => matches(node, label)), 'Android UI ' + String(label), timeout);
}
async function tap(label, { scroll = false, kind } = {}) {
  for (let attempt = 0; attempt < (scroll ? 22 : 2); attempt++) {
    const nodes = tree().nodes;
    const node = nodes.find(item => matches(item, label) && item.enabled &&
      item.bounds[2] - item.bounds[0] >= 20 && item.bounds[3] - item.bounds[1] >= 20 && (!kind || item.class.endsWith(kind)));
    if (node) { tapNode(node); await pause(250); return node; }
    const container = scroll && nodes.find(item => item.scrollable);
    if (!container) break;
    swipe(container);
    await pause(120);
  }
  throw new Error('Android UI target unavailable: ' + String(label));
}
async function text(label, value, deviceId = memberId, selectedRoom = roomId) {
  await tap(label);
  await api('/api/devices/' + deviceId + '/command', { tool: 'text', arguments: { text: value } }, undefined, selectedRoom);
  await until(() => tree().nodes.some(node => matches(node, label) &&
    (node.text === value || !value && ['搜索此目录中的文件和文件夹', '让手机与电脑帮你完成任务…'].includes(node.text))), 'input text applied');
  adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  await pause(550);
}
async function capture(name) {
  const snapshot = tree();
  await writeFile(resolve(evidence, name + '.xml'), snapshot.xml);
  const remote = '/sdcard/nexusroom-workspace-' + name + '.png';
  adb('shell', 'screencap', '-p', remote);
  adb('pull', remote, resolve(evidence, name + '.png'));
}
async function record(name, action) {
  const started = Date.now();
  try {
    await action();
    outcomes.push({ name, status: 'passed', seconds: Number(((Date.now() - started) / 1000).toFixed(1)) });
    console.log('PASS ' + name);
  } catch (error) {
    outcomes.push({ name, status: 'failed', error: redact(error.message), seconds: Number(((Date.now() - started) / 1000).toFixed(1)) });
    throw error;
  }
}
async function collapse() {
  const node = tree().nodes.find(item => item.description === '收起 Agent 悬浮窗');
  if (node) { tapNode(node); await pause(200); }
}
async function top() {
  for (let attempt = 0; attempt < 15; attempt++) {
    const nodes = tree().nodes;
    if (nodes.some(node => node.text === '我的房间')) return;
    const container = nodes.find(node => node.scrollable);
    if (!container) return;
    swipe(container, true);
    await pause(200);
  }
  throw new Error('Unable to scroll the actual Android room chooser into view');
}
async function openOverlay() {
  if (!tree().nodes.some(node => node.description === 'Nexus Agent 悬浮窗')) await tap('打开 Agent 悬浮窗');
  await visible('选择 Agent 目标设备');
}
async function pcTarget() {
  await openOverlay();
  await tap('选择 Agent 目标设备');
  await visible(node => node.text.startsWith(pcName + ' · ') && node.text.includes('在线'));
  await tap(node => node.text.startsWith(pcName + ' · ') && node.text.includes('在线'));
  await visible('选择 PC 工作目录');
}
async function openPicker() {
  await tap('选择 PC 工作目录');
  await visible('选择此文件夹');
  await until(() => tree().nodes.some(node => node.description === '当前文件夹' && !node.text.includes('正在读取')), 'picker loaded');
}
async function assertPath(path) {
  await until(() => tree().nodes.some(node => node.description === '当前文件夹' && node.text.toLowerCase() === path.toLowerCase()), 'directory ' + path);
}
async function enterFolder(name, path) {
  try { await tap(node => node.text === '📁  ' + name, { scroll: true }); }
  catch { throw new Error('Android folder row unavailable: ' + name); }
  if (path) await assertPath(path);
}
async function navigateFixture() {
  await tap('用户主目录');
  const drive = parse(fixture).root;
  await visible('打开磁盘 ' + drive);
  await tap('打开磁盘 ' + drive);
  await assertPath(drive);
  let current = drive;
  for (const part of relative(drive, fixture).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    // QA may run below a cache directory with hundreds of retained runs. Use
    // the real directory search instead of assuming a fixed swipe budget.
    await text('搜索当前目录的文件和文件夹', part);
    await enterFolder(part, current);
  }
}
function selectedWorkspace() { return tree().nodes.find(node => node.description === '选择 PC 工作目录')?.text || ''; }
async function selectedPc() {
  await until(() => tree().nodes.some(node => node.description === '选择 Agent 目标设备' && node.text === '目标设备：' + pcName), 'same PC target selected');
  await visible('选择 PC 工作目录');
}
async function invitation(selectedRoom = roomId) {
  return api('/api/invitation', undefined, 'GET', selectedRoom);
}
function guest(path, body, port) {
  return new Promise((done, reject) => {
    const request = https.request('https://127.0.0.1:' + port + path, {
      method: 'POST', rejectUnauthorized: false, headers: { 'Content-Type': 'application/json' }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        let value; try { value = JSON.parse(Buffer.concat(chunks).toString()); } catch { reject(new Error('Invalid QA guest response')); return; }
        if (response.statusCode !== 200) reject(new Error('QA guest HTTP ' + response.statusCode));
        else done(value);
      });
    });
    request.on('error', () => reject(new Error('Unable to join the isolated QA guest')));
    request.end(JSON.stringify(body));
  });
}
async function fakeMember(name) {
  const invite = await invitation();
  const value = await guest('/device/join', { roomId, password: invite.password, name, version: `${versionTag}-ui-qa`,
    physicalId: 'workspace-snapshot-' + Date.now() + '-' + name }, new URL(invite.server).port);
  temporaryMembers.push(value.deviceId);
  return value.deviceId;
}
async function removedSnapshotCheck() {
  const firstName = 'QA snapshot A ' + Date.now(), secondName = 'QA snapshot B ' + Date.now();
  const first = await fakeMember(firstName), second = await fakeMember(secondName);
  await pause(10500);
  await tap('选择 Agent 目标设备');
  await visible(node => node.text.startsWith(firstName + ' · '));
  await capture('target-snapshot-before');
  await api('/api/devices/' + first, undefined, 'DELETE');
  await pause(10500);
  // Tap the PC row from the dialog's original tree after a preceding row vanished.
  await tap(node => node.text.startsWith(pcName + ' · ') && node.text.includes('在线'));
  await selectedPc();
  await capture('target-snapshot-pc-selected');
  // Start from the Android target. A stale row index for the removed member
  // would now select the PC instead, making the wrong-device failure visible.
  await tap('选择 Agent 目标设备');
  await tap(node => node.text.startsWith(phoneName + ' · '));
  await visible(node => node.description === '选择 Agent 目标设备' && node.text === '目标设备：' + phoneName);
  await tap('选择 Agent 目标设备');
  await visible(node => node.text.startsWith(secondName + ' · '));
  await api('/api/devices/' + second, undefined, 'DELETE');
  await pause(10500);
  await tap(node => node.text.startsWith(secondName + ' · '));
  await visible(node => node.description === '选择 Agent 目标设备' && node.text === '目标设备：' + phoneName);
  assert.equal(tree().nodes.some(node => node.description === '选择 PC 工作目录'), false);
  assert.equal(tree().nodes.some(node => node.text === '选择 Agent 目标设备'), false);
  await capture('removed-target-does-not-select-another');
  await pcTarget();
  await selectedPc();
}
async function configureModel() {
  const settings = await api('/api/settings');
  originalPcEnabled = settings.pcAgentEnabled;
  originalDefaultProfile = settings.defaultProfileId;
  await api('/api/settings/pc-agent', { enabled: true });
  if (uiOnly) return;
  const profileId = process.env.NEXUS_WORKSPACE_PROFILE_ID;
  if (profileId) {
    modelProfile = settings.profiles.find(profile => profile.id === profileId && profile.hasKey);
    assert.ok(modelProfile, 'Configured QA profile is unavailable or lacks a key');
  } else {
    const stateFile = process.env.NEXUS_WORKSPACE_MODEL_STATE;
    assert.ok(stateFile, 'Set NEXUS_WORKSPACE_PROFILE_ID or NEXUS_WORKSPACE_MODEL_STATE, or use --ui-only');
    const selected = decrypt(stateFile, process.env.NEXUS_WORKSPACE_MODEL || 'deepseek-flash');
    secrets.push(selected.apiKey);
    modelProfile = await api('/api/settings/profiles', {
      name: `${versionTag} Android UI QA ` + selected.model, apiType: selected.apiType || 'chat_completions',
      apiUrl: selected.apiUrl, model: selected.model, apiKey: selected.apiKey,
      maxCalls: 12, maxSteps: 10, timeoutSeconds: 240
    });
    importedProfile = modelProfile.id;
    selected.apiKey = '';
  }
}
async function submitMarkerTask() {
  assert.ok(modelProfile, 'Model profile was not prepared');
  marker = `NEXUSROOM_${versionTag.toUpperCase()}_ANDROID_PC_OK_` + Date.now();
  await tap('选择房间模型方案');
  await tap(node => node.text.startsWith(modelProfile.name + ' · ' + modelProfile.model));
  await tap('自动模式');
  const task = 'Use the native pwsh tool to print the current working directory and write ' + markerName +
    ' in that current directory containing exactly ' + marker +
    '. Then use the native read filesystem tool to read that file and report its exact content. Do not change the working directory.';
  const before = new Set((await api('/api/agent/runs')).map(run => run.id));
  await text('输入 Agent 任务', task);
  await visible(node => node.text === '执行任务  ↑' && node.enabled);
  await capture('android-real-task-ready');
  await tap('执行任务  ↑');
  const started = await until(async () => (await api('/api/agent/runs')).find(run => !before.has(run.id) && run.task === task), 'Android UI submitted PC run');
  activeRunId = started.id;
  assert.equal(started.deviceId, 'pc:' + roomId, 'Android UI chose a different target');
  acceptedRun = await until(async () => {
    const run = (await api('/api/agent/runs')).find(item => item.id === started.id);
    return run && run.status !== 'running' ? run : false;
  }, 'real PC Harness completion', 270000);
  assert.equal(acceptedRun.status, 'completed', redact(acceptedRun.result));
  assert.equal((await readFile(resolve(workspace, markerName), 'utf8')).trim(), marker);
  assert.ok(acceptedRun.events.some(event => event.kind === 'tool' && event.tool === 'pwsh'), 'No native PowerShell operation');
  assert.ok(acceptedRun.events.some(event => event.kind === 'tool' && event.tool === 'read'), 'No native filesystem read operation');
  assert.ok(acceptedRun.result.includes(marker), 'PC result did not report the marker it read');
  const completedHeader = '自动模式 · 已完成\n' + task;
  const output = await visible(node => node.class === 'android.widget.TextView' &&
    node.text.includes(completedHeader), 25000);
  const currentBlock = output.text.slice(output.text.lastIndexOf(completedHeader));
  const readEvent = currentBlock.indexOf('调用 read');
  assert.ok(readEvent >= 0 && currentBlock.slice(readEvent).includes(marker),
    'Latest completed conversation block did not contain its native read operation');
  const previous = acceptedTasks.at(-1);
  if (previous) {
    assert.ok(output.text.includes(previous.marker), 'Prior recent task missing from the real conversation');
    assert.ok(output.text.lastIndexOf(marker) > output.text.lastIndexOf(previous.marker),
      'Latest completed task must appear after the previous task in the conversation');
  }
  await capture('android-real-task-completed');
  acceptedTasks.push({ id: acceptedRun.id, status: acceptedRun.status, target: acceptedRun.deviceId,
    tools: acceptedRun.events.filter(event => event.kind === 'tool').map(event => event.tool),
    markerFile: resolve(workspace, markerName), marker });
  if (previous) await capture('android-latest-multi-task-result');
}
async function pickerPauseCheck() {
  await openPicker(); await assertPath(workspace);
  await visible('📁  ' + basename(nestedWorkspace));
  const listing = await api('/api/agent/workspace?path=' + encodeURIComponent(workspace));
  const file = fileFixtures[0], entry = listing.files.find(item => item.name === file.name);
  assert.ok(entry, 'Updated APK workspace listing omitted the Unicode file');
  assert.equal(entry.size, file.bytes.length); assert.equal(entry.path, resolve(workspace, file.name));
  await text('搜索当前目录的文件和文件夹', file.name);
  await visible('📄  ' + file.name);
  await tap('📄  ' + file.name); await visible('电脑文件详情');
  await visible(node => node.text.includes('完整路径：') && node.text.includes(resolve(workspace, file.name)));
  await capture('file-details-before-pause');
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  adb('shell', 'am', 'start', '--activity-clear-top', '--activity-single-top', '-n', packageName + '/.MainActivity');
  await pause(700);
  assert.equal(tree().nodes.some(node => node.text === '电脑文件详情' || node.text === '选择 PC 工作目录'), false);
  await selectedPc(); assert.ok(selectedWorkspace().includes(workspace));
  await openPicker(); await assertPath(workspace); await tap('取消');
  await capture('folder-picker-pause-resumed');
}
async function joinTemporaryRoom(name) {
  assert.equal(temporaryRoom, undefined, 'Previous temporary room was not cleaned up');
  const created = await api('/api/rooms', { name });
  temporaryRoom = created.id;
  await api('/api/settings/pc-agent', { enabled: true }, undefined, temporaryRoom);
  const invite = await invitation(temporaryRoom);
  invite.server = process.env.NEXUS_WORKSPACE_ENDPOINT || phoneEndpoint || invite.server;
  await collapse();
  const url = new URL('nexusroom://join');
  url.searchParams.set('payload', JSON.stringify(invite));
  adb('shell', 'am', 'start', '--activity-clear-top', '--activity-single-top', '-a', 'android.intent.action.VIEW',
    '-d', url.toString(), '-n', packageName + '/.MainActivity');
  await tap('加入房间', { scroll: true });
  await tap('一致，加入');
  const secondary = await until(async () => (await api('/api/state', undefined, 'GET', temporaryRoom)).devices.find(device => device.online), 'Android joined lifecycle room');
  await openOverlay();
  await visible(node => node.text === created.name + ' · ' + pcName);
  await collapse();
  // MainActivity deliberately keeps its scroll position when it re-renders.
  // A preceding room may have been scrolled beyond the new permission row.
  await top();
  return { created, secondary };
}
async function roomLifecycle() {
  const { secondary } = await joinTemporaryRoom(`${versionTag} picker lifecycle QA`);
  await tap('Agent 操作', { scroll: true, kind: 'Switch' });
  await tap('允许 Agent');
  await until(async () => (await api('/api/state', undefined, 'GET', temporaryRoom)).devices.find(device => device.id === secondary.id)?.permissions.agent, 'secondary Agent grant');
  await pause(1000);
  await pcTarget();
  await openPicker();
  await capture('lifecycle-picker-open');
  await api('/api/rooms/' + temporaryRoom, undefined, 'DELETE');
  temporaryRoom = undefined;
  await until(() => !tree().nodes.some(node => node.text === '选择 PC 工作目录'), 'deleted-room picker dismissed');
  await until(async () => (await api('/api/state')).devices.find(device => device.id === memberId)?.online, 'original membership preserved');
  await openOverlay();
  await visible(node => node.text === roomName + ' · ' + pcName);
  await selectedPc();
  assert.ok(selectedWorkspace().includes(workspace), 'Original room lost its selected directory');
  await capture('lifecycle-original-room-restored');
}
async function roomActionLifecycle() {
  const original = (await api('/api/state')).devices.find(device => device.id === memberId);
  assert.ok(original?.online, 'Original Android membership must be online before stale-dialog QA');
  const originalAgentPermission = original.permissions.agent;
  const { created, secondary } = await joinTemporaryRoom(`${versionTag} permission dialog lifecycle QA`);
  assert.equal(secondary.permissions.agent, false, 'Temporary room unexpectedly started with Agent permission');
  await tap('Agent 操作', { scroll: true, kind: 'Switch' });
  await visible('允许 Agent 使用此房间？');
  await capture('room-action-permission-unconfirmed');
  const removedRoomId = temporaryRoom;
  await api('/api/rooms/' + removedRoomId, undefined, 'DELETE');
  temporaryRoom = undefined;
  await until(() => !tree().nodes.some(node => node.text === '允许 Agent 使用此房间？'), 'removed-room permission confirmation dismissed');
  await until(async () => {
    const device = (await api('/api/state')).devices.find(item => item.id === memberId);
    return device?.online && device.permissions.agent === originalAgentPermission;
  }, 'original membership and its Agent permission preserved');
  await collapse(); await top();
  assert.equal(tree().nodes.some(node => node.class.endsWith('Button') && node.text.includes(created.name + ' · ')), false,
    'Removed Android membership remained in the room chooser');
  assert.equal((await api('/api/rooms', undefined, 'GET', '')).some(room => room.id === removedRoomId), false);
  await openOverlay();
  await visible(node => node.text === roomName + ' · ' + pcName);
  await selectedPc();
  assert.ok(selectedWorkspace().includes(workspace), 'Stale permission cleanup lost the original room cwd');
  await capture('room-action-original-room-preserved');
  // This observes real modal removal and membership persistence. It does not
  // synthesize an already-queued Java callback; the source guard covers that race.
  await pause(5500);
  await collapse(); await top();
  assert.equal(tree().nodes.some(node => node.text === '允许 Agent 使用此房间？' ||
    node.class.endsWith('Button') && node.text.includes(created.name + ' · ')), false,
    'Deleted room or its permission dialog reappeared');
  const stable = (await api('/api/state')).devices.find(device => device.id === memberId);
  assert.equal(stable?.permissions.agent, originalAgentPermission);
  await openOverlay(); await selectedPc();
}

try {
  await mkdir(nestedWorkspace, { recursive: true });
  await mkdir(otherWorkspace, { recursive: true });
  for (const file of fileFixtures) await writeFile(resolve(workspace, file.name), file.bytes);
  const launch = new URL(decrypt(launchFile));
  assert.equal(launch.protocol, 'http:');
  assert.equal(launch.hostname, '127.0.0.1');
  assert.ok(launch.hash.startsWith('#bootstrap='));
  base = launch.origin;
  const token = decodeURIComponent(launch.hash.slice('#bootstrap='.length));
  secrets.push(token);
  headers = { Authorization: 'Bearer ' + token, 'X-Nexus-Request': '1', 'Content-Type': 'application/json' };
  const rooms = await api('/api/rooms', undefined, 'GET', '');
  const requestedRoom = process.env.NEXUS_WORKSPACE_ROOM_ID || process.env.NEXUS_TEST_ROOM_ID;
  const requestedDevice = process.env.NEXUS_WORKSPACE_DEVICE_ID;
  const matches = [];
  for (const candidate of rooms.filter(room => !requestedRoom || room.id === requestedRoom)) {
    const state = await api('/api/state', undefined, 'GET', candidate.id);
    for (const device of state.devices.filter(device => device.online && device.permissions.agent && (!requestedDevice || device.id === requestedDevice))) {
      matches.push({ room: candidate, device });
    }
  }
  assert.equal(matches.length, 1, 'Select exactly one authorized QA member with ROOM_ID/DEVICE_ID');
  roomId = matches[0].room.id; roomName = matches[0].room.name; memberId = matches[0].device.id;
  phoneName = matches[0].device.name;
  assert.ok(matches[0].device.permissions.control, 'QA room needs its actual Android remote input permission');
  assert.notEqual(matches[0].device.activity, 'busy', 'QA member is busy in another room');
  await configureModel();
  const packageInfo = adb('shell', 'dumpsys', 'package', packageName);
  assert.ok(packageInfo.includes('versionName=' + release.version), 'Installed APK does not match release.json');
  const installedPath = adb('shell', 'pm', 'path', packageName).split(/\r?\n/).find(path => path.endsWith('/base.apk'))?.replace(/^package:/, '');
  assert.ok(installedPath?.startsWith('/data/app/'), 'Unable to identify the installed APK');
  const installedApk = resolve(evidence, 'installed-base.apk');
  adb('pull', installedPath, installedApk);
  const hashApk = async file => createHash('sha256').update(await readFile(file)).digest('hex');
  apkSha256 = await hashApk(officialApk);
  assert.equal(await hashApk(installedApk), apkSha256, 'Installed APK differs from the formal artifact');
  adb('shell', 'am', 'start', '--activity-clear-top', '--activity-single-top', '-n', packageName + '/.MainActivity');
  await pause(700);
  if (tree().nodes.some(node => node.text === '选择 PC 工作目录' || node.text === '选择 Agent 目标设备' || node.text === '允许 Agent 使用此房间？')) await tap('取消');
  if (!narrowAcceptance) {
    await collapse(); await top();
    await tap(node => node.class.endsWith('Button') && node.text.includes(roomName + ' · '), { scroll: true });
    phoneEndpoint = tree().nodes.find(node => node.class.endsWith('TextView') && /^https:\/\//.test(node.text))?.text;
  }
  // A room may have enabled its PC Agent while Android was paused. Allow its
  // normal eight-second device/profile refresh before opening a snapshot menu.
  await pause(10500);
  if (!narrowAcceptance) {
  await record('real Android Agent overlay selects the authorized PC target', async () => {
    await pcTarget(); await selectedPc(); await capture('pc-target-selected');
  });
  await record('drive and parent navigation reach Chinese names and spaces', async () => {
    await openPicker(); await navigateFixture(); await enterFolder(basename(workspace), workspace);
    await enterFolder(basename(nestedWorkspace), nestedWorkspace);
    await tap('返回上级目录'); await assertPath(workspace);
    await tap('返回上级目录'); await assertPath(fixture);
    await capture('chinese-space-navigation');
  });
  await record('name search, no matches and clearing before folder navigation', async () => {
    await text('搜索当前目录的文件和文件夹', '没有此文件夹');
    await visible('没有匹配的文件或文件夹，可更改搜索词。');
    await text('搜索当前目录的文件和文件夹', '工作');
    await visible('📁  ' + basename(workspace));
    assert.equal(tree().nodes.some(node => node.text === '📁  ' + basename(otherWorkspace)), false);
    await capture('chinese-search-filtered');
    await text('搜索当前目录的文件和文件夹', '');
    await visible('📁  ' + basename(otherWorkspace));
    await enterFolder(basename(workspace), workspace);
    assert.ok(['', '搜索此目录中的文件和文件夹'].includes(tree().nodes.find(node => node.description === '搜索当前目录的文件和文件夹')?.text));
    await tap('选择此文件夹');
    assert.ok(selectedWorkspace().includes(workspace));
    await capture('folder-confirmed');
  });
  await record('all file types, zero bytes and file details preserve the selected folder', async () => {
    await openPicker(); await assertPath(workspace);
    await visible('📁  ' + basename(nestedWorkspace));
    const listing = await api('/api/agent/workspace?path=' + encodeURIComponent(workspace));
    for (const file of fileFixtures) {
      const entry = listing.files.find(item => item.name === file.name);
      assert.ok(entry, 'Host workspace listing omitted ' + file.name);
      assert.equal(entry.size, file.bytes.length);
      assert.equal(entry.path, resolve(workspace, file.name));
      await text('搜索当前目录的文件和文件夹', file.name);
      await visible('📄  ' + file.name);
      await visible(node => node.text.includes(file.type + ' · ' + file.bytes.length + ' B'));
      await tap('📄  ' + file.name);
      await visible('电脑文件详情');
      await visible(node => node.text.includes('完整路径：') && node.text.includes(resolve(workspace, file.name)));
      if (file.bytes.length === 0 || file.name.includes('中文')) await capture(file.bytes.length === 0 ? 'zero-byte-file-details' : 'unicode-file-details');
      await tap('关闭'); await assertPath(workspace);
    }
    await text('搜索当前目录的文件和文件夹', '');
    await visible('📁  ' + basename(nestedWorkspace));
    await tap('选择此文件夹');
    assert.ok(selectedWorkspace().includes(workspace), 'Inspecting a file changed the chosen cwd');
    await capture('files-and-folders');
  });
  await record('file detail copy pastes the complete Windows path into the Android task input', async () => {
    const before = tree().nodes.find(node => node.description === '输入 Agent 任务')?.text || '';
    const draft = before === '让手机与电脑帮你完成任务…' ? '' : before;
    await text('输入 Agent 任务', '');
    await openPicker(); await assertPath(workspace);
    await text('搜索当前目录的文件和文件夹', fileFixtures[0].name);
    await tap('📄  ' + fileFixtures[0].name); await visible('电脑文件详情');
    await tap('复制路径'); await assertPath(workspace); await tap('取消');
    await tap('输入 Agent 任务'); adb('shell', 'input', 'keyevent', 'KEYCODE_PASTE');
    await visible(node => node.description === '输入 Agent 任务' && node.text === resolve(workspace, fileFixtures[0].name));
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    await capture('copied-file-path'); await text('输入 Agent 任务', draft);
    assert.ok(selectedWorkspace().includes(workspace), 'Copying a file path changed the chosen cwd');
  });
  await record('cancel keeps the chosen cwd; default opens the Windows user directory', async () => {
    await openPicker(); await assertPath(workspace);
    await tap('返回上级目录'); await assertPath(fixture);
    await enterFolder(basename(otherWorkspace), otherWorkspace); await tap('取消');
    assert.ok(selectedWorkspace().includes(workspace));
    await openPicker(); await tap('使用默认目录');
    assert.ok(selectedWorkspace().includes('Windows 用户主目录'));
    await openPicker();
    const home = await api('/api/agent/workspace');
    await assertPath(home.defaultPath); await capture('default-user-directory');
    await navigateFixture(); await enterFolder(basename(workspace), workspace); await tap('选择此文件夹');
    assert.ok(selectedWorkspace().includes(workspace));
  });
  await record('activity pause dismisses target selection and retains the chosen cwd', async () => {
    await tap('选择 Agent 目标设备'); await visible(node => node.text.startsWith(pcName + ' · '));
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    adb('shell', 'am', 'start', '--activity-clear-top', '--activity-single-top', '-n', packageName + '/.MainActivity');
    await pause(700);
    assert.equal(tree().nodes.some(node => node.text === '选择 Agent 目标设备'), false);
    await selectedPc(); assert.ok(selectedWorkspace().includes(workspace)); await capture('activity-resumed');
  });
  await record('activity pause dismisses folder and file details and retains the chosen cwd', pickerPauseCheck);
  await record('target dialog refresh preserves device identity and rejects removed rows', removedSnapshotCheck);
  if (!uiOnly) await record('Android UI submits a real PC Harness task in the chosen cwd and reads its marker', submitMarkerTask);
  } else {
    await openOverlay();
    await visible(node => node.text === roomName + ' · ' + pcName);
    await pcTarget();
    assert.ok(selectedWorkspace().includes(workspace), 'Choose NEXUS_WORKSPACE_CWD in the QA room before a narrow acceptance pass');
    if (regressionOnly) await record('activity pause dismisses folder and file details and retains the chosen cwd', pickerPauseCheck);
    if (taskOnly || regressionOnly) await record('Android UI submits a real PC Harness task in the chosen cwd and reads its marker', submitMarkerTask);
    if (regressionOnly) await record('multiple real PC tasks display the latest result after earlier tasks', submitMarkerTask);
  }
  if (process.env.NEXUS_WORKSPACE_LIFECYCLE !== '0') {
    if (!roomActionOnly) await record('room dissolution closes a picker and restores the original room cwd', roomLifecycle);
    if (!lifecycleOnly) await record('room dissolution dismisses stale Agent permission and preserves original membership', roomActionLifecycle);
  }
  status = 'passed';
} catch (error) {
  failure = redact(error.message);
  console.error(failure);
  try { await capture('failure'); } catch {}
  process.exitCode = 1;
} finally {
  if (failure) try {
    if (tree().nodes.some(node => node.text === '选择 PC 工作目录' || node.text === '选择 Agent 目标设备' || node.text === '允许 Agent 使用此房间？')) await tap('取消');
  } catch {}
  if (headers && roomId) {
    if (temporaryRoom) try { await api('/api/rooms/' + temporaryRoom, undefined, 'DELETE'); } catch {}
    for (const id of temporaryMembers) try { await api('/api/devices/' + id, undefined, 'DELETE'); } catch {}
    if (activeRunId && acceptedRun?.id !== activeRunId) try {
      const current = (await api('/api/agent/runs')).find(run => run.id === activeRunId);
      if (current?.status === 'running') await api('/api/agent/runs/' + activeRunId, undefined, 'DELETE');
    } catch {}
    if (importedProfile) {
      if (originalDefaultProfile) try { await api('/api/settings/profiles/' + originalDefaultProfile + '/default', {}); } catch {}
      try { await api('/api/settings/profiles/' + importedProfile, undefined, 'DELETE'); } catch {}
    }
    if (originalPcEnabled !== undefined) try { await api('/api/settings/pc-agent', { enabled: originalPcEnabled }); } catch {}
  }
  await mkdir(evidence, { recursive: true });
  await writeFile(resolve(evidence, 'android-workspace-result.json'), JSON.stringify({
    version: release.version, status, error: failure, serial, uiOrigin: base, roomId, memberId,
    apk: { formalArtifact: officialApk, sha256: apkSha256 },
    fixtureDirectory: fixture, selectedWorkspace: workspace, outcomes,
    model: modelProfile ? { name: modelProfile.name, model: modelProfile.model } : undefined,
    task: acceptedRun ? { id: acceptedRun.id, status: acceptedRun.status, target: acceptedRun.deviceId,
      tools: acceptedRun.events.filter(event => event.kind === 'tool').map(event => event.tool),
      markerFile: resolve(workspace, markerName), marker } : undefined,
    tasks: acceptedTasks,
    time: new Date().toISOString()
  }, null, 2));
  console.log('Sanitized evidence: ' + resolve(evidence, 'android-workspace-result.json'));
}
