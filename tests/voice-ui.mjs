import { projectPath, generatedEvidencePath } from '../scripts/submission-paths.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

// Production React UI with bounded microphone API fixtures. Native offline model
// inference and Android hardware validation are separate from this browser test.
const root = resolve(import.meta.dirname, '..');
const release = JSON.parse(await readFile(projectPath(root, 'release.json'), 'utf8'));
const origin = 'http://127.0.0.1:18454';
const server = spawn(process.execPath, [projectPath(root, 'src/NexusRoom.Web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '18454', '--strictPort'], { cwd: projectPath(root, 'src/NexusRoom.Web'), windowsHide: true, stdio: 'ignore' });
const pause = milliseconds => new Promise(accept => setTimeout(accept, milliseconds));
const rooms = [{ id: 'room-a', name: '书房', open: true }, { id: 'room-b', name: '客厅', open: true }];
const status = { enabled: false, wakeEnabled: false, ready: true, phase: 'disabled', error: '', roomId: 'room-a', profileId: 'model-a', workspacePath: '' };
const starts = [], stops = [], cancels = [], settings = [], submissions = [], errors = [];
const tasks = [], runs = [], agentStops = [];
let checks = 0;
let browser, delayStart = false, releaseStart, expectedText = '在电脑上查看文件';
const state = roomId => ({ room: rooms.find(item => item.id === roomId), rooms, host: { name: 'QA Windows', system: 'Windows', version: release.version, online: true, activity: 'online', ownerRoom: '', remote: null, addresses: ['127.0.0.1'], fingerprint: 'qa' }, devices: [], transfers: [], approvals: [], media: { available: true, active: [] } });
const profile = { id: 'model-a', name: 'QA Room model', apiType: 'chat_completions', model: 'fixture', hasKey: true };
async function check(name, action) { await action(); checks++; console.log('PASS ' + name); }
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await fetch(origin).then(response => response.ok).catch(() => false)) break;
    assert.equal(server.exitCode, null, 'QA Vite server exited'); await pause(200);
  }
  browser = await chromium.launch(process.env.NEXUS_QA_BROWSER ? { executablePath: process.env.NEXUS_QA_BROWSER, headless: true } : { channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, room = request.headers()['x-nexus-room'] || 'room-a';
    const body = () => request.postDataJSON();
    if (path === '/api/state') return route.fulfill({ json: state(room) });
    if (path === '/api/settings') return route.fulfill({ json: { profiles: [profile], defaultProfileId: profile.id, pcAgentEnabled: true } });
    if (path === '/api/voice/status') return route.fulfill({ json: status });
    if (path === '/api/voice/tasks') return route.fulfill({ json: tasks });
    if (path === '/api/voice/settings') {
      settings.push({ room, ...body() }); Object.assign(status, body(), { roomId: room, phase: body().wakeEnabled ? 'listening' : body().enabled ? 'idle' : 'disabled' });
      return route.fulfill({ json: status });
    }
    if (path === '/api/voice/manual/start') {
      const recordingId = 'record-' + (starts.length + 1); starts.push({ room, recordingId });
      Object.assign(status, { phase: 'recording-manual', recordingId, recordingRoomId: room });
      if (delayStart) { delayStart = false; await new Promise(accept => { releaseStart = accept; }); }
      return route.fulfill({ json: { recordingId } });
    }
    if (path === '/api/voice/manual/stop') { stops.push({ room, ...body() }); status.phase = status.wakeEnabled ? 'listening' : 'idle'; delete status.recordingId; return route.fulfill({ json: { text: expectedText } }); }
    if (path === '/api/voice/manual/cancel') { cancels.push({ room, ...body() }); status.phase = status.wakeEnabled ? 'listening' : 'idle'; delete status.recordingId; return route.fulfill({ json: { ok: true } }); }
    if (path === '/api/agent/runs') {
      if (request.method() === 'POST') { submissions.push({ room, ...body() }); return route.fulfill({ json: { id: 'run', deviceId: `pc:${room}`, task: body().task, mode: body().mode, status: 'completed', startedAt: new Date().toISOString(), events: [] } }); }
      return route.fulfill({ json: runs });
    }
    if (path === '/api/agent/runs/voice-run' && request.method() === 'DELETE') { agentStops.push(room); runs.find(run => run.id === 'voice-run').status = 'cancelled'; return route.fulfill({ json: { ok: true } }); }
    return route.fulfill({ json: {} });
  });
  await page.goto(origin); await page.getByRole('button', { name: '打开 Agent 悬浮窗' }).click();
  const mic = page.locator('.voice-microphone');
  const text = page.getByRole('textbox', { name: '输入 Agent 任务' });
  const press = async () => { const bounds = await mic.boundingBox(); assert.ok(bounds); await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down(); };
  await check('voice defaults disabled and requires explicit local switch', async () => {
    await mic.waitFor(); assert.equal(await mic.isEnabled(), false); assert.equal(starts.length, 0);
    await page.getByRole('checkbox', { name: '本地语音' }).click();
    await page.waitForFunction(() => !document.querySelector('.voice-microphone').disabled);
    assert.equal(settings[0].enabled, true); assert.equal(settings[0].wakeEnabled, false);
  });
  await check('pointer release fills text without creating an Agent run', async () => {
    await press();
    await page.getByRole('button', { name: '松开麦克风完成本地转写' }).waitFor();
    await page.getByRole('status', { name: '本机正在录音' }).waitFor();
    await page.mouse.up();
    assert.equal(await page.getByRole('status', { name: '本机正在录音' }).count(), 0);
    await page.waitForFunction(() => document.querySelector('[aria-label="输入 Agent 任务"]').value.length > 0);
    assert.equal(await text.inputValue(), expectedText); assert.equal(stops.length, 1); assert.equal(submissions.length, 0);
  });
  await check('release while capture starts still finalizes one recording', async () => {
    await text.fill(''); delayStart = true;
    await press();
    await page.waitForFunction(() => document.querySelector('.voice-microphone small').textContent === '转写');
    await page.getByRole('status', { name: '本机正在录音' }).waitFor();
    await page.mouse.up();
    await page.waitForFunction(() => !document.querySelector('.voice-recording-indicator'));
    await pause(50); releaseStart(); await page.waitForFunction(() => document.querySelector('[aria-label="输入 Agent 任务"]').value.length > 0);
    assert.equal(stops.length, 2); assert.equal(submissions.length, 0);
  });
  await check('pointer cancellation cancels recording and retains existing text', async () => {
    await text.fill('保留我的文字'); await press();
    await page.getByRole('button', { name: '松开麦克风完成本地转写' }).waitFor();
    await mic.dispatchEvent('pointercancel', { pointerId: 1 }); await page.mouse.up(); await pause(150);
    assert.equal(cancels.length, 1); assert.equal(await text.inputValue(), '保留我的文字'); assert.equal(stops.length, 2);
  });
  await check('keyboard hold and release appends offline transcript', async () => {
    await mic.focus(); await page.keyboard.down('Space');
    await page.getByRole('button', { name: '松开麦克风完成本地转写' }).waitFor();
    await page.keyboard.up('Space'); await page.waitForFunction(() => document.querySelector('[aria-label="输入 Agent 任务"]').value.includes('\n'));
    assert.equal(await text.inputValue(), '保留我的文字\n' + expectedText); assert.equal(submissions.length, 0);
  });
  await check('Room switch cancels pending start in its original Room', async () => {
    delayStart = true; await press();
    await page.waitForFunction(() => document.querySelector('.voice-microphone small').textContent === '转写');
    await page.locator('#room-picker').selectOption('room-b'); await page.mouse.up(); await pause(150); releaseStart();
    await page.waitForFunction(() => document.querySelector('#room-picker').value === 'room-b'); await pause(200);
    assert.equal(cancels.at(-1).room, 'room-a'); assert.equal(cancels.at(-1).recordingId, starts.at(-1).recordingId);
    assert.equal(stops.length, 3); assert.equal(await text.inputValue(), '');
  });
  await check('wake explicitly authorizes automatic execution for selected Room', async () => {
    await page.getByRole('checkbox', { name: 'Hi Nexus · 自动执行' }).click(); await pause(150);
    assert.equal(settings.at(-1).wakeEnabled, true); assert.equal(settings.at(-1).room, 'room-b'); assert.equal(settings.at(-1).profileId, 'model-a');
    assert.equal(submissions.length, 0);
  });
  await check('remote Room voice tasks leave this device navigation and recording indicator unchanged', async () => {
    await page.getByRole('button', { name: '隐藏 Agent 悬浮窗' }).click();
    tasks.push({ taskId: 'phone-task', status: 'started', runId: 'phone-run', targetId: 'pc:room-b', sourceId: 'phone-b', createdAt: new Date().toISOString() });
    await pause(1200);
    assert.equal(await page.getByRole('dialog', { name: 'Nexus Agent 悬浮窗' }).isVisible(), false);
    assert.equal(await page.getByRole('status', { name: '本机正在录音' }).count(), 0);
  });
  await check('local wake opens Agent before task submission and shows an animated red recording dot', async () => {
    Object.assign(status, { phase: 'recording-wake', recordingId: 'wake-record', recordingRoomId: 'room-b', lastWake: { eventId: 'local-wake-1', roomId: 'room-b', detectedAt: new Date().toISOString() } });
    await page.getByRole('dialog', { name: 'Nexus Agent 悬浮窗' }).waitFor();
    await page.getByRole('status', { name: '本机正在录音' }).waitFor();
    const dot = page.locator('.voice-recording-indicator>i');
    assert.equal(await dot.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(224, 49, 49)');
    assert.equal(await dot.evaluate(element => getComputedStyle(element).animationName), 'voice-recording-blink');
    await mkdir(generatedEvidencePath(root, 'tests/evidence/voice-presentation-v1.0.0'), { recursive: true });
    await page.screenshot({ path: generatedEvidencePath(root, 'tests/evidence/voice-presentation-v1.0.0/windows-recording.png') });
    assert.equal(submissions.length, 0);
  });
  await check('transcription and errors remove the dot while idle KWS stays unmarked', async () => {
    for (const phase of ['transcribing', 'error', 'listening']) {
      status.phase = phase;
      await page.waitForFunction(() => !document.querySelector('.voice-recording-indicator'));
      await pause(550);
      assert.equal(await page.getByRole('status', { name: '本机正在录音' }).count(), 0);
    }
    delete status.recordingId;
  });
  await check('a handled wake does not reopen Agent after the user collapses it', async () => {
    await page.getByRole('button', { name: '隐藏 Agent 悬浮窗' }).click(); await pause(1200);
    assert.equal(await page.getByRole('dialog', { name: 'Nexus Agent 悬浮窗' }).isVisible(), false);
  });
  await check('a new local wake selects its bound Room and another Room never displays its recording', async () => {
    Object.assign(status, { roomId: 'room-a', phase: 'recording-wake', recordingId: 'wake-record-2', recordingRoomId: 'room-a', lastWake: { eventId: 'local-wake-2', roomId: 'room-a', detectedAt: new Date().toISOString() } });
    await page.waitForFunction(() => document.querySelector('#room-picker').value === 'room-a');
    await page.getByRole('status', { name: '本机正在录音' }).waitFor();
    await page.locator('#room-picker').selectOption('room-b');
    await page.waitForFunction(() => !document.querySelector('.voice-recording-indicator'));
    Object.assign(status, { roomId: 'room-b', phase: 'listening' }); delete status.recordingId;
  });
  await check('stale process-local wake data cannot navigate the UI', async () => {
    await page.getByRole('button', { name: '隐藏 Agent 悬浮窗' }).click();
    status.lastWake = { eventId: 'old-wake', roomId: 'room-a', detectedAt: new Date(Date.now() - 120000).toISOString() };
    await pause(1200);
    assert.equal(await page.locator('#room-picker').inputValue(), 'room-b');
    assert.equal(await page.getByRole('dialog', { name: 'Nexus Agent 悬浮窗' }).isVisible(), false);
    await page.getByRole('button', { name: '打开 Agent 悬浮窗' }).click();
  });
  await check('original text submission remains user confirmed', async () => {
    await text.fill('用户确认后执行'); await page.getByRole('checkbox', { name: /我同意将任务/ }).check();
    await page.getByRole('button', { name: '执行任务' }).click(); await pause(150);
    assert.equal(submissions.length, 1); assert.equal(submissions[0].task, '用户确认后执行'); assert.equal(submissions[0].room, 'room-b');
  });
  await check('wake uses existing run/stop and preserves the original text task mode', async () => {
    await page.getByRole('button', { name: '隐藏 Agent 悬浮窗' }).click();
    runs.push({ id: 'voice-run', deviceId: 'pc:room-b', task: '语音自动任务', mode: 'automatic', status: 'running', startedAt: new Date().toISOString(), events: [{ kind: 'assistant', text: '既有 Agent 正在执行', time: new Date().toISOString() }] });
    tasks.push({ taskId: 'voice-task', wakeId: 'wake', status: 'started', targetId: 'pc:room-b', runId: 'voice-run', text: '语音自动任务', error: '', createdAt: new Date().toISOString(), sourceId: 'pc:room-b' });
    await page.getByRole('dialog', { name: 'Nexus Agent 悬浮窗' }).waitFor();
    await page.getByText('既有 Agent 正在执行').waitFor();
    await page.getByRole('button', { name: '停止任务' }).click(); await pause(150);
    assert.deepEqual(agentStops, ['room-b']); assert.equal(submissions.length, 1);
    await page.waitForFunction(() => document.querySelector('.agent-mode-bar button').getAttribute('aria-pressed') === 'true');
    assert.equal(await page.getByRole('button', { name: '请求模式' }).getAttribute('aria-pressed'), 'true');
    await text.fill('仍然按请求模式发送'); await page.getByRole('button', { name: '执行任务' }).click(); await pause(150);
    assert.equal(submissions.length, 2); assert.equal(submissions[1].mode, 'request');
    assert.equal(await page.evaluate(version => localStorage.getItem(`nexusroom:${version}:agent-mode:room-b`), release.version), null);
  });
  assert.deepEqual(errors, []);
  await mkdir(generatedEvidencePath(root, 'tests/evidence/voice-v1.0.0'), { recursive: true });
  await writeFile(generatedEvidencePath(root, 'tests/evidence/voice-v1.0.0/ui.json'), JSON.stringify({ suite: 'voice-ui', checks, passed: true, productionReact: true, microphoneApiFixture: true, realMicrophone: false, agentModel: false, credentials: false }, null, 2) + '\n');
  console.log(`PASS voice UI: ${checks} executable browser regressions.`);
} finally { releaseStart?.(); await browser?.close(); server.kill(); }
