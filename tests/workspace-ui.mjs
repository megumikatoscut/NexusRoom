import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join, basename, parse, relative, sep } from 'node:path';
import { chromium } from 'playwright';
import { once } from 'node:events';
import https from 'node:https';
import WebSocket from 'ws';

const root = resolve(import.meta.dirname, '..');
const release = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'));
const data = await mkdtemp(join(root, '.local', 'workspace-ui-v' + release.version + '-'));
const workspace = join(data, '工作 目录');
await mkdir(workspace);
await writeFile(join(workspace, '说明 文件.txt'), 'NexusRoom 文件浏览');
await writeFile(join(workspace, 'empty.json'), '');
await writeFile(join(workspace, 'image.png'), Buffer.from([137, 80, 78, 71]));
await writeFile(join(workspace, 'archive.zip'), Buffer.from([80, 75, 3, 4]));
await mkdir(join(data, '其他 测试'));
const executable = process.env.NEXUS_TEST_HOST || join(root, 'src/NexusRoom.Host/bin/Debug/net10.0-windows/NexusRoom.Host.exe');
const host = spawn(executable, ['--headless'], { windowsHide: true, stdio: 'ignore',
  env: { ...process.env, NEXUS_DATA_DIR: data, NEXUS_UI_PORT: '18390', NEXUS_DEVICE_PORT: '18391', NEXUS_DISCOVERY_PORT: '18392', NEXUS_DISABLE_MDNS: '1' } });
const base = 'http://127.0.0.1:18390';
const pause = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
let browser, peer;
try {
  for (let i = 0; i < 80; i++) {
    if (await fetch(base + '/health').then(r => r.ok).catch(() => false)) break;
    if (host.exitCode !== null) throw new Error('QA Host failed to start');
    await pause(200);
  }
  const launch = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command',
    'Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($env:NEXUS_UI_QA_LAUNCH),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))'],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, NEXUS_UI_QA_LAUNCH: join(data, 'launch.dat') } }).trim());
  browser = await chromium.launch(process.env.NEXUS_QA_BROWSER ? { executablePath: process.env.NEXUS_QA_BROWSER, headless: true } : { channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text() + ' ' + message.location().url); });
  await page.goto(launch);
  await page.getByRole('heading', { name: '房间总览', exact: true }).waitFor();
  assert.match(await page.title(), /NexusRoom/);
  await page.getByRole('button', { name: '打开 Agent 悬浮窗', exact: true }).click();
  const agent = page.getByRole('dialog', { name: 'Nexus Agent 悬浮窗' });
  assert.equal(await agent.getByRole('textbox', { name: 'PC 工作目录', exact: true }).count(), 0);
  await agent.getByRole('button', { name: '选择 PC 工作目录', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择 PC 工作目录', exact: true });
  await picker.getByRole('button', { name: '选择此文件夹', exact: true }).waitFor();
  const volume = parse(root).root;
  const rootButton = picker.getByRole('button').filter({ hasText: volume.slice(0, 2) }).first();
  await rootButton.click();
  for (const folder of relative(volume, root).split(sep))
    await picker.getByRole('button', { name: folder + ' 打开文件夹', exact: true }).click();
  await picker.getByRole('button', { name: '.local 打开文件夹', exact: true }).click();
  await picker.getByRole('button', { name: basename(data) + ' 打开文件夹', exact: true }).click();
  await picker.getByRole('button', { name: '其他 测试 打开文件夹', exact: true }).waitFor();
  const search = picker.getByRole('textbox', { name: '搜索当前目录的文件和文件夹', exact: true });
  await search.fill('没有这个文件夹');
  await picker.getByText('没有匹配的文件或文件夹，可更改搜索词。', { exact: true }).waitFor();
  await search.fill('工作');
  await picker.getByRole('button', { name: '工作 目录 打开文件夹', exact: true }).waitFor();
  await page.waitForTimeout(100);
  assert.equal(await picker.getByRole('button', { name: '其他 测试 打开文件夹', exact: true }).count(), 0);
  await picker.getByRole('button', { name: '工作 目录 打开文件夹', exact: true }).click();
  await picker.getByRole('button', { name: '说明 文件.txt 查看文件信息', exact: true }).waitFor();
  for (const filename of ['empty.json', 'image.png', 'archive.zip'])
    await picker.getByRole('button', { name: filename + ' 查看文件信息', exact: true }).waitFor();
  await picker.getByRole('button', { name: 'empty.json 查看文件信息', exact: true }).click();
  await picker.getByRole('region', { name: '文件详情' }).getByText('JSON 文件 · 0 B', { exact: true }).waitFor();
  assert.equal(await picker.getByLabel('当前文件夹').textContent(), workspace);
  assert.equal(await picker.getByLabel('文件路径').textContent(), join(workspace, 'empty.json'));
  await search.fill('说明');
  await page.waitForFunction(() => !document.querySelector('.workspace-browser')?.getAttribute('aria-busy')?.includes('true') && document.querySelectorAll('.workspace-file').length === 1);
  assert.equal(await picker.getByRole('button', { name: 'image.png 查看文件信息', exact: true }).count(), 0);
  await search.fill('');
  await picker.getByRole('button', { name: 'image.png 查看文件信息', exact: true }).waitFor();
  assert.equal(await search.inputValue(), '');
  assert.equal(await picker.getByLabel('当前文件夹').textContent(), workspace);
  const evidence = process.env.NEXUS_QA_EVIDENCE || data;
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, 'windows-folder-picker.png') });
  await picker.getByRole('button', { name: '选择此文件夹', exact: true }).click();
  assert.equal(await agent.getByLabel('PC 工作目录', { exact: true }).textContent(), workspace);
  await agent.getByRole('button', { name: '选择 PC 工作目录', exact: true }).click();
  await picker.getByRole('button', { name: '说明 文件.txt 查看文件信息', exact: true }).waitFor();
  await picker.getByRole('button', { name: '返回上级目录', exact: true }).click();
  await picker.getByRole('button', { name: '工作 目录 打开文件夹', exact: true }).waitFor();
  await picker.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await agent.getByLabel('PC 工作目录', { exact: true }).textContent(), workspace);
  await agent.getByRole('button', { name: '使用默认工作目录', exact: true }).click();
  assert.equal(await agent.getByLabel('PC 工作目录', { exact: true }).textContent(), 'Windows 用户主目录');
  await page.setViewportSize({ width: 430, height: 900 });
  await agent.getByRole('button', { name: '选择 PC 工作目录', exact: true }).click();
  await picker.getByRole('button', { name: '用户主目录', exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const bounds = await picker.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 430 && bounds.y >= 0 && bounds.y + bounds.height <= 900);
  await page.screenshot({ path: join(evidence, 'windows-folder-picker-narrow.png') });
  await picker.getByRole('button', { name: '取消', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await agent.getByRole('button', { name: '隐藏 Agent 悬浮窗' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('heading', { name: '设置', exact: true }).waitFor();
  const first = await page.evaluate(() => fetch('/api/state').then(r => r.json()));
  const second = await page.evaluate(() => fetch('/api/rooms', { method: 'POST', headers: { 'X-Nexus-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'QA 第二房间' }) }).then(r => r.json()));
  await page.getByLabel('当前房间', { exact: true }).selectOption(second.id);
  await page.getByLabel('房间名称').waitFor();
  assert.equal(await page.getByLabel('房间名称').inputValue(), 'QA 第二房间');
  const uploaded = await page.evaluate(async room => {
    const response = await fetch('/api/files', { method: 'POST', headers: { 'X-Nexus-Request': '1', 'X-Nexus-Room': room, 'X-File-Name': 'qa-room-two.txt', 'Content-Type': 'application/octet-stream' }, body: 'SECOND_ROOM_DOWNLOAD_OK' });
    return response.status;
  }, second.id);
  assert.equal(uploaded, 200);
  await page.getByRole('button', { name: '文件传输', exact: true }).click();
  const pendingDownload = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载 qa-room-two.txt', exact: true }).click();
  const download = await pendingDownload;
  assert.equal(await download.failure(), null);
  assert.equal(await readFile(await download.path(), 'utf8'), 'SECOND_ROOM_DOWNLOAD_OK');
  const invitation = await page.evaluate(room => fetch('/api/invitation?roomId=' + room).then(r => r.json()), second.id);
  const member = await new Promise((resolvePromise, reject) => {
    const request = https.request('https://127.0.0.1:18391/device/join', { method: 'POST', rejectUnauthorized: false,
      headers: { 'Content-Type': 'application/json' } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => response.statusCode === 200 ? resolvePromise(JSON.parse(Buffer.concat(chunks))) : reject(new Error('QA phone join failed')));
    });
    request.on('error', reject);
    request.end(JSON.stringify({ roomId: second.id, password: invitation.password, name: 'QA 第二房间手机', version: 'test', physicalId: 'workspace-ui-room-two' }));
  });
  peer = new WebSocket('wss://127.0.0.1:18391/device/ws', { rejectUnauthorized: false, headers: { Authorization: 'Bearer ' + member.token } });
  peer.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.type !== 'command') return;
    peer.send(JSON.stringify({ type: 'result', id: message.id, result: { ok: true } }));
    if (message.tool === 'stream_keyframe') {
      const frame = Buffer.alloc(12); frame[0] = 0x80; frame.writeUInt32BE(640, 4); frame.writeUInt32BE(360, 8);
      peer.send(frame);
    }
  });
  await once(peer, 'open');
  peer.send(JSON.stringify({ type: 'hello', activity: 'working', permissions: { screen: true, control: true, files: true }, width: 640, height: 360 }));
  const streamOpened = page.waitForEvent('websocket', { predicate: ws => ws.url().includes('/mirror/stream') });
  await page.getByRole('button', { name: '设备控制', exact: true }).click();
  const stream = await streamOpened;
  assert.equal(new URL(stream.url()).searchParams.get('roomId'), second.id, 'media stream must authenticate the selected room');
  await page.locator('.screen-toolbar > span').filter({ hasText: '640 × 360' }).waitFor();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('当前房间', { exact: true }).selectOption(first.room.id);
  await page.getByLabel('房间名称').waitFor();
  assert.equal(await page.getByLabel('房间名称').inputValue(), first.room.name);
  assert.deepEqual(errors, []);
  await writeFile(join(evidence, 'workspace-ui-result.json'), JSON.stringify({ version: release.version, desktop: true, narrow: true, folderNavigation: true, files: ['txt', 'json', 'png', 'zip'], zeroByteFile: true, fileDetails: true, search: true, parent: true, cancel: true, default: true, roomSwitch: true, secondRoomDownload: true, secondRoomMediaStream: true, runtimeErrors: errors.length }, null, 2));
  console.log('PASS Windows files/folders/details/search/selection, zero-byte files, 430px layout, second-room download/media stream and console health');
} finally {
  peer?.terminate();
  await browser?.close();
  host.kill();
  console.log('QA evidence: ' + data);
}
