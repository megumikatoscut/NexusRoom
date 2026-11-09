import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';

// Browser contract regression. Media/input execution is covered by the separate
// Windows + Android live acceptance; this fixture checks local consent and room UI.
const root = resolve(import.meta.dirname, '..');
const release = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'));
const origin = 'http://127.0.0.1:18440';
const server = spawn(process.execPath, [join(root, 'src/NexusRoom.Web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '18440', '--strictPort'], { cwd: join(root, 'src/NexusRoom.Web'), windowsHide: true, stdio: 'ignore' });
const pause = ms => new Promise(accept => setTimeout(accept, ms));
const rooms = [{ id: 'room-a', name: '书房', open: true }, { id: 'room-b', name: '客厅', open: true }];
const grants = Object.fromEntries(rooms.map(room => [room.id, { screen: false, control: false, audio: false, clipboard: false }]));
let session = null, delayedRoom = '', releaseDelayed, delayedArrived = false;
const decisions = [], permissionsWrites = [], stopRooms = [], uploads = [], invitationResponses = [];
const baseDevice = { id: 'phone-a', name: '测试手机', system: 'Android', version: '12', ip: '192.168.1.10', battery: 90, charging: false, width: 1080, height: 1920, lastSeen: new Date().toISOString(), physicalId: 'phone', activity: 'online', ownerRoom: '', online: true, permissions: { screen: false, control: true, screenAllowed: true, audio: true, files: true, clipboard: true, agent: true } };
const remoteStatus = room => ({ permissions: grants[room], activity: session && session.state !== 'pending' ? session.roomId === room ? 'working' : 'busy' : 'online', session });
const roomState = room => ({ room: rooms.find(item => item.id === room), rooms, host: { name: 'QA Windows', system: 'Windows', version: release.version, online: true, activity: remoteStatus(room).activity, ownerRoom: session?.roomName || '', remote: remoteStatus(room), addresses: ['https://192.168.1.2:17891', 'https://192.168.1.3:17891'], fingerprint: 'test-fingerprint' }, devices: [{ ...baseDevice, roomId: room }], transfers: [], approvals: [], media: { available: true, active: [], pending: [] } });
const profile = { id: 'model-a', name: '测试方案', apiType: 'chat_completions', apiUrl: 'https://example.invalid/v1', model: 'test-model', maxCalls: 24, maxSteps: 24, timeoutSeconds: 900, hasKey: false };
const settings = room => ({ apiUrl: profile.apiUrl, model: profile.model, hasKey: false, confirmMutations: true, pcAgentEnabled: false, pcRemotePermissions: grants[room], sharedFolders: [], hasExternalToken: false, dataDirectory: 'QA data', defaultProfileId: profile.id, profiles: [profile] });
let browser;
try {
  for (let attempt = 0; attempt < 60; attempt++) { if (await fetch(origin).then(response => response.ok).catch(() => false)) break; assert.equal(server.exitCode, null, 'QA Web server did not start'); await pause(200); }
  browser = await chromium.launch(process.env.NEXUS_QA_BROWSER ? { executablePath: process.env.NEXUS_QA_BROWSER, headless: true } : { channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), room = request.headers()['x-nexus-room'] || 'room-a';
    const body = request.postDataJSON.bind(request);
    if (url.pathname === '/api/state') {
      if (room === delayedRoom) { delayedRoom = ''; delayedArrived = true; await new Promise(accept => { releaseDelayed = accept; }); return route.fulfill({ status: 410, json: { title: '房间已解散（旧请求）' } }); }
      return route.fulfill({ json: roomState(room) });
    }
    if (url.pathname === '/api/settings') return route.fulfill({ json: settings(room) });
    if (url.pathname === '/api/agent/runs') return route.fulfill({ json: [] });
    if (url.pathname === '/api/voice/status') return route.fulfill({ json: { enabled: false, wakeEnabled: false, ready: true, phase: 'disabled', error: '', roomId: '', profileId: '', workspacePath: '' } });
    if (url.pathname === '/api/voice/tasks') return route.fulfill({ json: [] });
    if (url.pathname === '/api/pc/remote/permissions') { const value = body(); assert.deepEqual(Object.keys(value).sort(), ['audio', 'clipboard', 'control', 'screen']); assert.ok(Object.values(value).every(item => typeof item === 'boolean')); grants[room] = value; permissionsWrites.push({ room, value }); return route.fulfill({ json: remoteStatus(room) }); }
    if (url.pathname === '/api/pc/remote/decision') { const value = body(); assert.equal(room, session.roomId); assert.equal(value.sessionId, session.sessionId); decisions.push({ room, ...value }); session = value.allow ? { ...session, state: 'approved' } : null; return route.fulfill({ json: remoteStatus(room) }); }
    if (url.pathname === '/api/pc/remote/stop') { assert.equal(room, session.roomId); stopRooms.push(room); session = null; return route.fulfill({ json: remoteStatus(room) }); }
    if (url.pathname === '/api/files' && request.method() === 'POST') { uploads.push({ room, device: url.searchParams.get('deviceId') }); return route.fulfill({ json: {} }); }
    if (url.pathname === '/api/invitation') {
      if (invitationResponses.length) await invitationResponses.shift()();
      return route.fulfill({ json: { version: 2, server: url.searchParams.get('address') || 'https://192.168.1.2:17891', roomId: room, password: url.searchParams.get('address')?.includes('.3:') ? 'new-invitation' : 'old-invitation', fingerprint: 'test-fingerprint', name: 'QA' } });
    }
    throw new Error('Unexpected UI request: ' + request.method() + ' ' + url.pathname);
  });
  await page.goto(origin);
  await page.getByRole('heading', { name: '房间总览', exact: true }).waitFor();
  await page.getByRole('button', { name: '文件传输', exact: true }).click();
  const target = page.getByRole('combobox', { name: '选择文件发送目标' });
  await target.selectOption('phone-a'); await target.selectOption('');
  await page.waitForTimeout(2800);
  assert.equal(await target.inputValue(), '', 'Local-library selection must survive refresh');
  await page.locator('input[type=file]').setInputFiles({ name: 'local-library.txt', mimeType: 'text/plain', buffer: Buffer.from('LOCAL_LIBRARY') });
  await page.getByText('文件已导入，点击发送即可传至 Android', { exact: true }).waitFor();
  assert.deepEqual(uploads, [{ room: 'room-a', device: '' }]);

  await page.getByRole('button', { name: '设置', exact: true }).click();
  const permissions = page.getByRole('region', { name: 'Windows 远程访问权限' });
  await permissions.waitFor();
  for (const name of ['查看电脑画面', '鼠标与键盘操作', '电脑播放声音', '剪贴板传输']) assert.equal(await permissions.getByRole('checkbox', { name: '允许手机' + name }).isChecked(), false);
  await permissions.getByRole('checkbox', { name: '允许手机查看电脑画面' }).click();
  await page.getByText('此房间的电脑远程权限已开启', { exact: true }).waitFor();
  assert.equal(await permissions.getByRole('checkbox', { name: '允许手机查看电脑画面' }).isChecked(), true);
  assert.deepEqual(permissionsWrites[0], { room: 'room-a', value: { screen: true, control: false, audio: false, clipboard: false } });
  assert.equal(await page.getByRole('checkbox', { name: /允许房间 Agent 操作这台电脑/ }).isChecked(), false, 'Remote access must not enable Agent');

  session = { sessionId: 'request-one', state: 'pending', deviceId: 'phone-a', deviceName: '测试手机', roomId: 'room-a', roomName: '书房', error: '' };
  const notice = page.getByRole('alert').filter({ hasText: '手机请求访问这台电脑' });
  await notice.waitFor();
  await notice.getByText('仅查看画面，手机不能操作鼠标或键盘。', { exact: true }).waitFor();
  assert.match(await notice.innerText(), /书房/); assert.match(await notice.innerText(), /窗口与通知/);
  await notice.getByRole('button', { name: '拒绝电脑远程访问', exact: true }).click();
  await page.getByText('已拒绝本次电脑远程访问', { exact: true }).waitFor();
  assert.equal(decisions.at(-1).allow, false);
  session = { ...roomState('room-a').host.remote.session, sessionId: 'request-two', state: 'pending', deviceId: 'phone-a', deviceName: '测试手机', roomId: 'room-a', roomName: '书房', error: '' };
  await notice.waitFor(); await notice.getByRole('button', { name: '允许本次电脑远程访问', exact: true }).click();
  await page.getByText('电脑远程访问已批准，等待连接', { exact: true }).waitFor();
  assert.equal(decisions.at(-1).allow, true);
  session.state = 'streaming';
  await page.getByText('这台电脑正在远程共享', { exact: true }).waitFor();
  await page.getByRole('button', { name: '房间总览', exact: true }).click();
  assert.equal(await page.locator('.host-row .status').innerText(), '工作');
  await page.getByRole('button', { name: '打开 Agent 悬浮窗', exact: true }).click();
  const agent = page.getByRole('dialog', { name: 'Nexus Agent 悬浮窗' });
  assert.match(await agent.getByRole('combobox', { name: '选择 Agent 设备' }).first().locator('option').first().innerText(), /工作/);
  await page.getByRole('button', { name: '隐藏 Agent 悬浮窗', exact: true }).click();
  await page.getByLabel('当前房间', { exact: true }).selectOption('room-b');
  await page.getByText('前往此房间处理请求或结束共享。当前房间的电脑状态为忙碌。', { exact: true }).waitFor();
  assert.equal(await page.locator('.host-row .status').innerText(), '忙碌');
  assert.equal(await page.getByRole('button', { name: '结束电脑远程共享', exact: true }).count(), 0, 'Another room cannot issue stop');
  await page.getByRole('button', { name: '前往「书房」', exact: true }).click();
  await page.getByRole('button', { name: '结束电脑远程共享', exact: true }).click();
  await page.getByText('电脑远程共享已结束', { exact: true }).waitFor();
  assert.deepEqual(stopRooms, ['room-a']);
  assert.equal(await page.locator('.host-row .status').innerText(), '在线');

  delayedRoom = 'room-a';
  for (let attempt = 0; attempt < 40 && !delayedArrived; attempt++) await pause(100);
  assert.equal(delayedArrived, true, 'Old room state request was captured');
  await page.getByLabel('当前房间', { exact: true }).selectOption('room-b');
  await page.getByRole('heading', { name: '客厅', exact: true }).waitFor();
  releaseDelayed(); await page.waitForTimeout(300);
  assert.equal(await page.getByLabel('当前房间', { exact: true }).inputValue(), 'room-b', 'Old-room error must not reset the new room');
  assert.equal(await page.getByText('房间已解散（旧请求）', { exact: true }).count(), 0);

  let releaseOldInvite;
  invitationResponses.push(() => new Promise(accept => { releaseOldInvite = accept; }));
  await page.getByRole('button', { name: '添加设备', exact: true }).click();
  for (let attempt = 0; attempt < 30 && !releaseOldInvite; attempt++) await pause(100);
  assert.ok(releaseOldInvite);
  const invitation = page.getByRole('dialog', { name: '邀请设备加入房间', exact: true });
  await invitation.getByLabel('电脑地址').selectOption('https://192.168.1.3:17891');
  await invitation.getByRole('button', { name: '显示密码', exact: true }).click();
  await invitation.getByText('new-invitation', { exact: true }).waitFor();
  releaseOldInvite(); await page.waitForTimeout(300);
  assert.equal(await invitation.getByText('old-invitation', { exact: true }).count(), 0, 'Late invitation must not replace latest address/password');
  await invitation.getByRole('button', { name: '关闭', exact: true }).click();

  session = { sessionId: 'narrow-request', state: 'pending', deviceId: 'phone-a', deviceName: '测试手机', roomId: 'room-b', roomName: '客厅', error: '' };
  grants['room-b'] = { screen: true, control: true, audio: true, clipboard: false };
  await notice.waitFor();
  await page.setViewportSize({ width: 430, height: 900 });
  const evidence = process.env.NEXUS_QA_EVIDENCE || join(root, '.local', 'pc-remote-ui-v' + release.version);
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, 'pc-remote-consent-narrow.png') });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Consent controls fit narrow viewports');
  assert.deepEqual(errors, []);
  console.log(`PASS Web ${release.version}: local-library import, independent grants, view-only disclosure, allow/reject, working/busy/online, room-scoped stop, stale state error, stale invitation, narrow consent and no runtime errors`);
  console.log('UI evidence: ' + evidence);
} finally { releaseDelayed?.(); await browser?.close(); server.kill(); }
