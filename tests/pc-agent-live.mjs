import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import WebSocket from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.env.NEXUS_TEST_STATE;
if (!source) throw new Error('Set NEXUS_TEST_STATE to a NexusRoom data directory with a configured model profile');
const data = resolve(root, '.local', `pc-agent-live-${Date.now()}`);
await mkdir(data, { recursive: true });
await copyFile(resolve(source, 'state.dat'), resolve(data, 'state.dat'));
const port = 18090;
const base = `http://127.0.0.1:${port}`;
const hostExecutable = process.env.NEXUS_TEST_HOST;
const child = spawn(hostExecutable || 'dotnet', hostExecutable ? ['--headless'] : [process.env.NEXUS_TEST_HOST_DLL || resolve(root, 'src/NexusRoom.Host/bin/Debug/net10.0-windows/NexusRoom.Host.dll'), '--headless'], {
  cwd: root, windowsHide: true,
  env: { ...process.env, NEXUS_DATA_DIR: data, NEXUS_UI_PORT: String(port), NEXUS_DEVICE_PORT: '18091', NEXUS_DISCOVERY_PORT: '18092', NEXUS_DISABLE_MDNS: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let hostErrors = '';
child.stderr.on('data', chunk => { hostErrors += chunk.toString(); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 120000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(300); }
  throw new Error('Timed out');
}
async function approveUntilDone(runId, targetId, outside, decide) {
  const seen = new Set();
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const run = (await api('/api/agent/runs')).find(item => item.id === runId);
    assert.ok(run, 'PC run disappeared');
    if (run.status !== 'running') {
      assert.ok(seen.size > 0, 'Harness did not request approval');
      return run;
    }
    const pending = (await api('/api/state')).approvals.find(item => item.runId === runId);
    if (pending && !seen.has(pending.id)) {
      if (!run.events.some(event => event.kind === 'permission_required' && event.requestId === pending.requestId)) {
        await delay(300);
        continue;
      }
      assert.equal(pending.deviceId, targetId);
      assert.ok(pending.requestId, 'Approval request ID was missing');
      assert.ok(pending.arguments?.arguments?.command?.includes(outside), 'Approval did not show the expected file path');
      seen.add(pending.id);
      assert.ok(seen.size <= 5, 'Unexpected number of approval requests');
      await decide(pending);
    }
    await delay(300);
  }
  throw new Error('Timed out waiting for approved PC run');
}
let token = '';
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + path, { method,
    headers: { Authorization: `Bearer ${token}`, 'X-Nexus-Request': '1', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${value.title}`);
  return value;
}
async function phone(path, body, credential = '') {
  return new Promise((resolve, reject) => {
    const request = https.request(`https://127.0.0.1:18091${path}`, { method: 'POST', rejectUnauthorized: false,
      headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const value = JSON.parse(Buffer.concat(chunks).toString());
        if (response.statusCode !== 200) reject(new Error(`${path}: ${response.statusCode} ${value.title}`));
        else resolve(value);
      });
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}
let peer;
try {
  await until(async () => { try { return (await fetch(base + '/health')).ok; } catch { return false; } }, 15000);
  const launch = resolve(data, 'launch.dat').replaceAll("'", "''");
  const expression = `[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes('${launch}'),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))`;
  const launchUrl = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Security; ${expression}`], { encoding: 'utf8', windowsHide: true }).trim());
  token = new URL(launchUrl).hash.split('=')[1];
  const state = await api('/api/state');
  const settings = await api('/api/settings');
  const profile = settings.profiles.find(p => p.hasKey && (process.env.NEXUS_TEST_MODEL ? p.model === process.env.NEXUS_TEST_MODEL : true));
  assert.ok(profile, 'No saved profile with an API key');
  await api('/api/settings', { profileId: profile.id, profileName: profile.name, apiUrl: profile.apiUrl,
    apiType: profile.apiType, model: profile.model, apiKey: '', pcAgentEnabled: true, confirmMutations: true,
    maxCalls: profile.maxCalls, maxSteps: profile.maxSteps, timeoutSeconds: profile.timeoutSeconds });
  const targetId = `pc:${state.room.id}`;
  const workspacePath = resolve(data, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  console.log(`PC target ${targetId}, model ${profile.model}, workspace ${workspacePath}`);
  const started = await api('/api/agent/runs', { targetId, task: 'Use the native pwsh tool to get the current working directory and list its files, then create harness-check.txt in that directory containing only NEXUSROOM_HARNESS_OK. Next use the native read filesystem tool, NOT PowerShell Get-Content, to read that file and report its exact content.', mode: 'automatic', profileId: profile.id, workspacePath });
  const run = await until(async () => (await api('/api/agent/runs')).find(item => item.id === started.id && item.status !== 'running'), 180000);
  console.log(JSON.stringify({ status: run.status, result: run.result, eventTypes: run.events.map(e => `${e.kind}:${e.tool}`).slice(0, 30) }));
  assert.equal(run.status, 'completed', run.result);
  assert.equal((await readFile(resolve(workspacePath, 'harness-check.txt'), 'utf8')).trim(), 'NEXUSROOM_HARNESS_OK');
  assert.ok(run.events.some(e => e.kind === 'tool'), 'No Harness tool call was projected');
  assert.ok(run.events.some(event => event.kind === 'tool' && event.tool === 'pwsh'), 'Native PowerShell tool was not called');
  assert.ok(run.events.some(event => event.kind === 'tool' && event.tool === 'read'), 'Native filesystem read tool was not called');
  for (const call of run.events.filter(event => event.kind === 'tool')) {
    assert.ok(run.events.some(event => ['result', 'error'].includes(event.kind)
      && event.requestId === call.requestId && event.tool === call.tool), 'Real SDK tool result lost its call ID or tool name');
  }
  console.log('PASS PC SDK profile, model route, PowerShell and filesystem task');
  const held = await api('/api/agent/runs', { targetId, task: 'Wait for 90 seconds using PowerShell, then answer DONE.', mode: 'automatic', profileId: profile.id, workspacePath });
  await until(async () => (await api('/api/agent/runs')).find(item => item.id === held.id)?.events.some(e => e.kind === 'tool'), 90000);
  await api(`/api/agent/runs/${held.id}`, undefined, 'DELETE');
  const cancelled = await until(async () => (await api('/api/agent/runs')).find(item => item.id === held.id && item.status !== 'running'));
  assert.equal(cancelled.status, 'cancelled');
  console.log('PASS PC Stop/cancel');
  if (process.env.NEXUS_TEST_APPROVAL === '1') {
    const outside = resolve(root, '.local', `pc-agent-approval-${Date.now()}.txt`);
    const requestTask = `Use the pwsh tool to write exactly APPROVED_PC to '${outside}'. This path is outside the working directory. Set sandbox_permissions to danger-full-access and provide a one-sentence justification, then wait for the human approval. Read the file back and report its content.`;
    const requested = await api('/api/agent/runs', { targetId, task: requestTask, mode: 'request', profileId: profile.id, workspacePath });
    const approved = await approveUntilDone(requested.id, targetId, outside,
      pending => api(`/api/approvals/${pending.id}`, { allow: true }));
    assert.equal(approved.status, 'completed', approved.result);
    assert.equal((await readFile(outside, 'utf8')).trim(), 'APPROVED_PC');
    assert.ok(approved.events.some(event => event.text.includes('allowed-once')));
    console.log('PASS PC request mode one-shot approval through NexusRoom UI API');

    const stopped = await api('/api/agent/runs', { targetId, task: requestTask, mode: 'request', profileId: profile.id, workspacePath });
    await until(async () => (await api('/api/state')).approvals.some(item => item.runId === stopped.id), 120000);
    await api(`/api/agent/runs/${stopped.id}`, undefined, 'DELETE');
    const afterStop = await until(async () => (await api('/api/agent/runs')).find(item => item.id === stopped.id && item.status !== 'running'));
    assert.equal(afterStop.status, 'cancelled');
    assert.ok(!(await api('/api/state')).approvals.some(item => item.runId === stopped.id));
    console.log('PASS PC request mode Stop revokes pending approval');
  }
  if (process.env.NEXUS_TEST_GUI === '1') {
    const gui = await api('/api/agent/runs', { targetId, task: 'Use the cua_driver_native__check_permissions tool with prompt=false, then use cua_driver_native__list_windows to inspect the Windows desktop. Report the number of windows found. Do not use PowerShell for this task.', mode: 'automatic', profileId: profile.id, workspacePath });
    const observed = await until(async () => (await api('/api/agent/runs')).find(item => item.id === gui.id && item.status !== 'running'), 180000);
    console.log(JSON.stringify({ guiStatus: observed.status, guiTools: observed.events.filter(e => e.kind === 'tool').map(e => e.tool) }));
    assert.equal(observed.status, 'completed', observed.result);
    assert.ok(observed.events.some(e => e.tool === 'cua_driver_native__check_permissions'), 'Cua tool was not called');
    assert.ok(observed.events.some(e => e.tool === 'cua_driver_native__list_windows'), 'Cua did not inspect desktop windows');
    console.log('PASS PC Cua computer-use task');
  }
  if (process.env.NEXUS_TEST_BROWSER === '1') {
    const browser = await api('/api/agent/runs', { targetId, task: `Use the Playwright browser_navigate tool to open ${base}/health. Read the page snapshot and report the product value. Do not use PowerShell or web_fetch for this task.`, mode: 'automatic', profileId: profile.id, workspacePath });
    const observed = await until(async () => (await api('/api/agent/runs')).find(item => item.id === browser.id && item.status !== 'running'), 180000);
    console.log(JSON.stringify({ browserStatus: observed.status, browserTools: observed.events.filter(e => e.kind === 'tool').map(e => e.tool), result: observed.result.slice(0, 300) }));
    assert.equal(observed.status, 'completed', observed.result);
    assert.ok(observed.events.some(e => e.tool?.includes('browser_navigate')), 'Playwright navigation was not called');
    console.log('PASS PC Playwright browser-use task');
  }
  if (process.env.NEXUS_TEST_ANDROID_TO_PC === '1') {
    const invitation = await api('/api/invitation');
    const member = await phone('/device/join', { roomId: invitation.roomId, password: invitation.password,
      name: 'PC Agent route fixture', version: 'test', physicalId: 'pc-agent-live-route' });
    peer = new WebSocket('wss://127.0.0.1:18091/device/ws', { rejectUnauthorized: false,
      headers: { Authorization: `Bearer ${member.token}` } });
    await new Promise((resolve, reject) => { peer.once('open', resolve); peer.once('error', reject); });
    peer.send(JSON.stringify({ type: 'hello', battery: 100, width: 1080, height: 1920,
      permissions: { agent: true, files: true, screen: false, control: false, clipboard: false } }));
    await until(async () => (await api('/api/state')).devices.some(item => item.id === member.deviceId && item.online && item.permissions.agent));
    const forwarded = await phone('/device/agent/runs', { targetDeviceId: targetId,
      task: 'Reply with exactly ANDROID_TO_PC_OK.', mode: 'automatic', profileId: profile.id, workspacePath }, member.token);
    const observed = await until(async () => (await api('/api/agent/runs')).find(item => item.id === forwarded.id && item.status !== 'running'), 180000);
    assert.equal(observed.deviceId, targetId);
    assert.equal(observed.status, 'completed', observed.result);
    assert.ok(observed.result.includes('ANDROID_TO_PC_OK'), observed.result);
    console.log('PASS Android-to-PC prompt enters PcAgentRunner and DeepSeek Harness');
    if (process.env.NEXUS_TEST_APPROVAL === '1') {
      const outside = resolve(root, '.local', `android-to-pc-approval-${Date.now()}.txt`);
      const requested = await phone('/device/agent/runs', { targetDeviceId: targetId,
        task: `Use the pwsh tool to write exactly ANDROID_APPROVED_PC to '${outside}'. This path is outside the working directory. Set sandbox_permissions to danger-full-access and provide a one-sentence justification, then wait for human approval. Read it back and report the content.`,
        mode: 'request', profileId: profile.id, workspacePath }, member.token);
      const approved = await approveUntilDone(requested.id, targetId, outside,
        pending => phone('/device/agent/approve', { taskId: requested.id, requestId: pending.requestId, approved: true }, member.token));
      assert.equal(approved.status, 'completed', approved.result);
      assert.equal((await readFile(outside, 'utf8')).trim(), 'ANDROID_APPROVED_PC');
      console.log('PASS Android-to-PC request mode approval through existing phone endpoint');
    }
  }
  if (process.env.NEXUS_TEST_LIMITS === '1') {
    const configure = (maxCalls, maxSteps) => api('/api/settings', { profileId: profile.id, profileName: profile.name,
      apiUrl: profile.apiUrl, apiType: profile.apiType, model: profile.model, apiKey: '', maxCalls, maxSteps,
      timeoutSeconds: profile.timeoutSeconds, pcAgentEnabled: true, confirmMutations: true });
    await configure(1, 5);
    const callLimited = await api('/api/agent/runs', { targetId,
      task: 'Use pwsh exactly once to execute Get-Location. After getting the tool result, reply with the directory.',
      mode: 'automatic', profileId: profile.id, workspacePath });
    const callResult = await until(async () => (await api('/api/agent/runs')).find(item => item.id === callLimited.id && item.status !== 'running'), 180000);
    assert.equal(callResult.status, 'failed', callResult.result);
    assert.match(callResult.result, /最多模型调用/);
    assert.ok(callResult.events.some(event => event.tool === 'pwsh'));
    console.log('PASS real SDK model-call limit blocks the second model request');
    await configure(8, 1);
    const stepLimited = await api('/api/agent/runs', { targetId,
      task: 'First call pwsh with Get-Location. Then in a SEPARATE second tool call use pwsh with Get-Date. Do not combine commands. Report both results.',
      mode: 'automatic', profileId: profile.id, workspacePath });
    const stepResult = await until(async () => (await api('/api/agent/runs')).find(item => item.id === stepLimited.id && item.status !== 'running'), 180000);
    assert.equal(stepResult.status, 'failed', stepResult.result);
    assert.ok(stepResult.events.some(event => event.errorType === 'NEXUSROOM_LIMIT' && event.tool === 'pwsh'), stepResult.result);
    console.log('PASS real SDK tool-step limit blocks dispatch before side effects');
    await configure(profile.maxCalls, profile.maxSteps);
  }
} catch (error) {
  console.error(error.message);
  if (hostErrors) console.error(hostErrors.slice(-1000));
  process.exitCode = 1;
} finally {
  peer?.close();
  child.kill();
  await until(() => child.exitCode !== null || child.signalCode !== null, 10000).catch(() => {});
  console.log(`Isolated state: ${data}`);
}
