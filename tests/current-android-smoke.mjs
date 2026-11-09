import { projectPath } from '../scripts/submission-paths.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Exercise the signed release on an explicitly selected phone, using its current
// room. Cancellation keeps the existing draft; no Agent task is submitted.
const root = resolve(import.meta.dirname, '..');
const release = JSON.parse(await readFile(projectPath(root, 'release.json'), 'utf8'));
const serial = process.env.NEXUS_QA_SERIAL;
assert.ok(serial, 'Select a connected phone with NEXUS_QA_SERIAL. USB and TCP aliases may refer to the same phone.');
const adbExe = process.env.NEXUS_QA_ADB || 'adb';
const output = resolve(process.env.NEXUS_SMOKE_OUTPUT || projectPath(root, '.local/current-android-smoke.json'));
const apkCopy = projectPath(root, '.local/current-installed-base.apk');
const results = [];
let originalOpen, originalDraft, pointer, originalVoice, settingsChanged = false, device;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function adb(...args) {
  try { return execFileSync(adbExe, ['-s', serial, ...args], { encoding: 'utf8', windowsHide: true, timeout: 25000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error('The selected phone did not complete the adb operation'); }
}
const decode = text => text.replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
function nodes() {
  const raw = adb('exec-out', 'uiautomator', 'dump', '/dev/tty');
  return [...raw.matchAll(/<node\b[^>]*>/g)].map(([tag]) => {
    const attr = name => decode(tag.match(new RegExp('\\b' + name + '="([^"]*)"'))?.[1] || '');
    return { text: attr('text'), desc: attr('content-desc'), enabled: attr('enabled') === 'true', checked: attr('checked') === 'true', bounds: (attr('bounds').match(/\d+/g) || []).map(Number) };
  });
}
const find = (tree, label) => tree.find(node => node.text === label || node.desc === label);
function tapNode(node) {
  assert.ok(node?.bounds.length === 4, 'Required production UI control is visible');
  const [x1,y1,x2,y2] = node.bounds;
  adb('shell', 'input', 'tap', String(Math.round((x1+x2)/2)), String(Math.round((y1+y2)/2)));
}
async function tap(label) { tapNode(find(nodes(), label)); await pause(250); }
async function until(predicate, timeout = 12000) {
  const deadline = Date.now() + timeout;
  do { const tree = nodes(); if (predicate(tree)) return tree; await pause(200); } while (Date.now() < deadline);
  throw new Error('Required Android UI state timed out');
}
async function check(name, action) {
  const start = Date.now();
  try { await action(); results.push({ name, status: 'passed', seconds: Number(((Date.now()-start)/1000).toFixed(2)) }); console.log('PASS ' + name); }
  catch (error) { results.push({ name, status: 'failed', error: error.message }); throw error; }
}
async function press() {
  const mic = find(nodes(), '长按麦克风，松开后填入任务');
  assert.ok(mic?.enabled, 'Enable offline input and grant microphone access before this test');
  const [x1,y1,x2,y2] = mic.bounds;
  pointer = [String(Math.round((x1+x2)/2)), String(Math.round((y1+y2)/2))];
  adb('shell', 'input', 'motionevent', 'DOWN', ...pointer);
  await until(tree => find(tree, '本机正在录音') && find(tree, '正在录音，松开完成转写'));
}
function cancelPointer() { if (pointer) { adb('shell', 'input', 'motionevent', 'CANCEL', ...pointer); pointer = undefined; } }
let error;
try {
  await mkdir(projectPath(root, '.local'), { recursive: true });
  await check('installed signed APK matches the current release bytes and version', async () => {
    assert.equal(adb('get-state'), 'device');
    const pkg = adb('shell', 'dumpsys', 'package', 'com.nexusroom.android');
    assert.equal(pkg.match(/versionName=(\S+)/)?.[1], release.version);
    assert.equal(Number(pkg.match(/versionCode=(\d+)/)?.[1]), release.androidVersionCode);
    const path = adb('shell', 'pm', 'path', 'com.nexusroom.android').replace(/^package:/, '');
    adb('pull', path, apkCopy);
    const digest = bytes => createHash('sha256').update(bytes).digest('hex');
    const sha256 = digest(await readFile(apkCopy));
    assert.equal(sha256, digest(await readFile(projectPath(root, 'artifacts', `NexusRoom-Android-${release.version}.apk`))));
    device = { model: adb('shell', 'getprop', 'ro.product.model'), android: adb('shell', 'getprop', 'ro.build.version.release'), api: Number(adb('shell', 'getprop', 'ro.build.version.sdk')), abi: adb('shell', 'getprop', 'ro.product.cpu.abi'), apkSha256: sha256 };
  });
  await check('production Agent exposes text, communication and voice controls', async () => {
    adb('shell', 'am', 'start', '-n', 'com.nexusroom.android/.MainActivity');
    const tree = await until(tree => find(tree, '打开 Agent 悬浮窗') || find(tree, '收起 Agent 悬浮窗'));
    originalOpen = !!find(tree, '收起 Agent 悬浮窗');
    if (!originalOpen) await tap('打开 Agent 悬浮窗');
    const panel = nodes();
    for (const label of ['输入 Agent 任务', '安排会议或通话', '选择 Agent 目标设备', '离线语音设置', '长按麦克风，松开后填入任务']) assert.ok(find(panel, label), label);
    originalDraft = find(panel, '输入 Agent 任务').text;
    assert.ok(!find(panel, '本机正在录音'));
  });
  await check('voice settings expose separate wake, background listening and launch grants', async () => {
    await tap('离线语音设置');
    const tree = nodes();
    for (const label of ['离线语音输入', 'Hi Nexus 自动唤醒', '允许后台监听（持续麦克风通知）', '允许后台唤醒打开 Agent']) assert.ok(find(tree, label), label);
    originalVoice = ['离线语音输入', 'Hi Nexus 自动唤醒', '允许后台监听（持续麦克风通知）'].map(label => ({ label, checked: find(tree, label).checked }));
    for (const setting of originalVoice) {
      const desired = setting.label === '离线语音输入';
      if (setting.checked !== desired) { tapNode(find(nodes(), setting.label)); settingsChanged = true; }
    }
    await tap(settingsChanged ? '保存' : '取消');
  });
  await check('physical microphone hold displays the device-local recording dot', press);
  await check('touch cancellation removes the recording dot and retains the draft', async () => {
    cancelPointer();
    await until(tree => !find(tree, '本机正在录音') && find(tree, '长按麦克风，松开后填入任务'));
    assert.ok(find(nodes(), '输入 Agent 任务').text === originalDraft, 'Cancellation retains the original draft');
  });
  await check('a second recording starts after cancellation', press);
  await check('Home pauses recording and return retains the original draft', async () => {
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME'); cancelPointer(); await pause(300);
    adb('shell', 'am', 'start', '-n', 'com.nexusroom.android/.MainActivity');
    const tree = await until(tree => find(tree, '输入 Agent 任务') && !find(tree, '本机正在录音'));
    assert.ok(find(tree, '输入 Agent 任务').text === originalDraft, 'Returning from Home retains the original draft');
  });
  await check('an unrecognized external wake intent keeps the Agent collapsed', async () => {
    await tap('收起 Agent 悬浮窗');
    adb('shell', 'am', 'start', '--activity-single-top', '-n', 'com.nexusroom.android/.MainActivity', '-a', 'com.nexusroom.android.LOCAL_VOICE_WAKE', '--es', 'voice_member', 'invalid-smoke-member', '--es', 'voice_event', 'invalid-smoke-event');
    const tree = await until(tree => find(tree, '打开 Agent 悬浮窗'));
    assert.ok(!find(tree, '收起 Agent 悬浮窗'));
  });
} catch (caught) { error = caught; }
finally {
  try {
    cancelPointer();
    if (settingsChanged) {
      if (find(nodes(), '打开 Agent 悬浮窗')) await tap('打开 Agent 悬浮窗');
      await tap('离线语音设置');
      for (const setting of originalVoice) if (find(nodes(), setting.label).checked !== setting.checked) tapNode(find(nodes(), setting.label));
      await tap('保存');
    }
    if (originalOpen && find(nodes(), '打开 Agent 悬浮窗')) await tap('打开 Agent 悬浮窗');
    if (originalOpen === false && find(nodes(), '收起 Agent 悬浮窗')) await tap('收起 Agent 悬浮窗');
  } catch (cleanupError) { error ||= cleanupError; }
  await rm(apkCopy, { force: true });
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, JSON.stringify({ schemaVersion: 1, version: release.version, androidVersionCode: release.androidVersionCode, date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()), timezone: 'Asia/Shanghai', status: error ? 'failed' : 'passed', device, checks: results, method: 'Signed release APK on physical phone; adb touch events and local microphone; production UI and lifecycle; existing draft retained; no Agent submission', cleanup: error ? 'See failed check' : 'Pointer cancelled, temporary APK removed, original input setting and panel state restored', ...(error ? { error: error.message } : {}) }, null, 2) + '\n');
}
if (error) throw error;
console.log(`${results.length} physical Android release checks passed.`);
