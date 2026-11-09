import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const uiPort = Number(process.env.NEXUS_CONTRACT_UI_PORT || 18690);
const devicePort = Number(process.env.NEXUS_CONTRACT_DEVICE_PORT || 18691);
const discoveryPort = Number(process.env.NEXUS_CONTRACT_DISCOVERY_PORT || 18692);
const base = 'http://127.0.0.1:' + uiPort;
const data = resolve(root, '.local', 'pc-agent-contract-' + Date.now());
const runtime = resolve(data, 'runtime');
const workspace = resolve(data, 'workspace');
const packagedFixture = process.env.NEXUS_CONTRACT_PACKAGED_HARNESS === '1';
const fixtureBin = resolve(runtime, packagedFixture ? 'node_modules/@deepseek-ai/dsh/lib/bin.js' : 'apps/cli/lib/bin.js');
await mkdir(dirname(fixtureBin), { recursive: true });
await mkdir(workspace, { recursive: true });
await copyFile(resolve(root, 'tests/fixtures/harness-runtime.mjs'), fixtureBin);
const child = spawn('dotnet', [process.env.NEXUS_TEST_HOST_DLL || resolve(root, 'src/NexusRoom.Host/bin/Debug/net10.0-windows/NexusRoom.Host.dll'), '--headless'], {
  cwd: root, windowsHide: true,
  env: { ...process.env, NEXUS_DATA_DIR: data, NEXUS_UI_PORT: String(uiPort), NEXUS_DEVICE_PORT: String(devicePort),
    NEXUS_DISCOVERY_PORT: String(discoveryPort), NEXUS_DISABLE_MDNS: '1', NEXUS_HARNESS_DIR: runtime },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let diagnostics = '';
child.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(50); }
  throw new Error('Contract check timed out');
}
let token = '';
async function request(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + path, { method,
    headers: { Authorization: 'Bearer ' + token, 'X-Nexus-Request': '1', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, value: await response.json() };
}
async function api(path, body, method) {
  const result = await request(path, body, method);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  return result.value;
}
let targetId;
let profile;
const start = (task, extra = {}) => api('/api/agent/runs', { targetId, profileId: profile.id, workspacePath: workspace,
  mode: 'automatic', task, ...extra });
const done = id => until(async () => (await api('/api/agent/runs')).find(run => run.id === id && run.status !== 'running'));
const trace = id => readFile(resolve(workspace, id + '.json'), 'utf8').then(JSON.parse);
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
let count = 0;
let failed = 0;
async function check(name, action) {
  try { await action(); count++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); await delay(1100); }
}

try {
  await until(async () => {
    if (child.exitCode !== null) throw new Error('Contract Host exited before readiness: ' + diagnostics.slice(-1000));
    try { await access(resolve(data, 'launch.dat')); return (await fetch(base + '/health')).ok; }
    catch { return false; }
  });
  const launchPath = resolve(data, 'launch.dat').replaceAll("'", "''");
  const script = "Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes('" + launchPath + "'),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))";
  const launch = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  token = new URL(launch).hash.slice('#bootstrap='.length);
  targetId = 'pc:' + (await api('/api/state')).room.id;
  profile = await api('/api/settings/profiles', { name: 'PC contract', apiType: 'chat_completions',
    apiUrl: 'https://api.example.test/v1/chat/completions', apiKey: 'contract-key', model: 'contract-model',
    maxCalls: 3, maxSteps: 2, timeoutSeconds: 60 });

  await check('PC workspace rejects relative or invalid paths as 400', async () => {
    for (const workspacePath of ['.', resolve(root, '.local', 'not-present-contract'), resolve(root, '.local', 'invalid\u0000path')]) {
      const result = await request('/api/agent/runs', { targetId, profileId: profile.id, task: 'normal', mode: 'automatic', workspacePath });
      if (result.status === 200) await api('/api/agent/runs/' + result.value.id, undefined, 'DELETE');
      assert.equal(result.status, 400, 'unexpected status for ' + JSON.stringify(workspacePath));
    }
  });
  await check('PC terminal status follows SDK shutdown, process exit and patch cleanup', async () => {
    const run = await done((await start('normal')).id);
    assert.equal(run.status, 'completed');
    const observed = await trace(run.id);
    assert.equal(observed.shutdown, true);
    assert.equal(alive(observed.pid), false, 'runtime is still alive after terminal status');
    await assert.rejects(access(resolve(data, 'harness/patches', run.id + '.yml')));
  });
  await check('PC selected model, provider, key, workspace, limits and modes reach child environment', async () => {
    for (const [mode, permissionMode] of [['automatic', 'danger-full-access'], ['request', 'workspace-write']]) {
      const run = await done((await start('normal', { mode })).id);
      const observed = await trace(run.id);
      assert.equal(observed.cwd, workspace);
      assert.equal(observed.initialize.cwd, workspace);
      assert.equal(observed.initialize.provider, 'nexusroom');
      assert.equal(observed.initialize.model, 'contract-model');
      assert.equal(observed.api, 'openai-completions');
      assert.equal(observed.baseUrl, 'https://api.example.test/v1');
      assert.equal(observed.keyMatches, true);
      assert.equal(observed.permissionMode, permissionMode);
      assert.equal(observed.maxCalls, '3');
      assert.equal(observed.maxSteps, '2');
      assert.equal(observed.roomFilesBridgePresent, true, 'PC task did not receive its dedicated room-file pipe');
      assert.equal(observed.roomFilesPluginPresent, true, 'SDK patch did not mount the NexusRoom room-file plugin');
      assert.notEqual(observed.home, workspace);
      assert.notEqual(observed.cwd, runtime);
      if (packagedFixture) {
        assert.ok(observed.execArgv.includes('--preserve-symlinks'));
        assert.ok(observed.execArgv.includes('--preserve-symlinks-main'));
        assert.equal(observed.nodeOptions, '--preserve-symlinks --preserve-symlinks-main');
        assert.match(observed.browserPath, /NexusRoom-runtime/);
        assert.equal(observed.primaryRuntimeAvailable, true);
      }
    }
  });
  await check('PC Stop cooperatively shuts down the runtime and clears pending state', async () => {
    const started = await start('hold');
    await until(async () => (await api('/api/agent/runs')).find(run => run.id === started.id)?.events.some(event => event.kind === 'tool'));
    await api('/api/agent/runs/' + started.id, undefined, 'DELETE');
    const run = await done(started.id);
    assert.equal(run.status, 'cancelled');
    const observed = await trace(run.id);
    assert.equal(observed.shutdown, true, 'Stop killed runtime without SDK shutdown');
    assert.equal(alive(observed.pid), false);
    assert.equal((await api('/api/state')).approvals.some(item => item.runId === run.id), false);
  });
  await check('PC idle without a completed turn is not reported as success', async () => {
    assert.equal((await done((await start('no-turn-end')).id)).status, 'failed');
  });
  await check('PC runtime tool limit fails run and correlates call arguments/results', async () => {
    for (const scenario of ['limit', 'limit-flat']) {
      const run = await done((await start(scenario)).id);
      assert.equal(run.status, 'failed');
      const call = run.events.find(event => event.kind === 'tool');
      assert.equal(call.tool, 'pwsh');
      assert.equal(call.arguments.command, 'Get-Location');
      assert.ok(run.events.some(event => event.kind === 'error' && event.tool === 'pwsh'
        && event.requestId === call.requestId && event.errorType === 'NEXUSROOM_LIMIT'), scenario);
    }
  });
  await check('PC stdout rejects ordinary logs while stderr stays outside protocol', async () => {
    const run = await done((await start('invalid-stdout')).id);
    assert.equal(run.status, 'failed');
    assert.match(run.result, /非 JSON-RPC/);
  });
  await check('PC rejected approval remains failed even if the native turn finishes normally', async () => {
    const run = await done((await start('approval-denied')).id);
    assert.equal(run.status, 'failed');
    assert.match(run.result, /操作未获批准/);
    assert.ok(run.events.some(event => event.errorType === 'ApprovalDenied'));
  });
  await check('PC provider failure is preserved and secrets are redacted from events/results', async () => {
    const error = await done((await start('error')).id);
    assert.equal(error.status, 'failed');
    assert.match(error.result, /provider rejected request/);
    const secret = await done((await start('secret')).id);
    assert.equal(JSON.stringify(secret).includes('contract-key'), false);
  });
  await check('PC duplicate running task is rejected', async () => {
    const run = await start('hold');
    const duplicate = await request('/api/agent/runs', { targetId, profileId: profile.id, task: 'normal', mode: 'automatic', workspacePath: workspace });
    assert.equal(duplicate.status, 409);
    await api('/api/agent/runs/' + run.id, undefined, 'DELETE');
    await done(run.id);
  });
  console.log(count + ' PC contract checks passed; ' + failed + ' failed. Fixture transport only; real SDK checks run separately.');
  if (failed) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  if (diagnostics) console.error(diagnostics.slice(-1000));
  process.exitCode = 1;
} finally {
  child.kill();
  await until(() => child.exitCode !== null || child.signalCode !== null).catch(() => {});
}
