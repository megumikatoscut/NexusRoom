import {execFileSync} from 'node:child_process';

const usage = `Usage: node tests/phone-agent-live-audit.mjs --tool TOOL [--args '{"key":"value"}']
  [--mode automatic|request] [--api-type chat_completions|responses]
  [--max-calls N] [--max-steps N] [--timeout-seconds N] [--poll-seconds N]

Required environment:
  NEXUS_LIVE_LAUNCH_FILE  DPAPI-protected launch.dat of the running Host
  NEXUS_LIVE_DEVICE_NAME or NEXUS_LIVE_DEVICE_ID
  NEXUS_AUDIT_API_KEY, NEXUS_AUDIT_API_URL, NEXUS_AUDIT_MODEL

Optional environment: NEXUS_AUDIT_ROOM_ID to select a room explicitly.
The script creates a temporary profile, tests the provider connection, asks the
phone Agent to call TOOL once, polls the run, and deletes the profile.`;

function options(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    if (option === '--help' || option === '-h') return {help: true};
    if (!['--tool', '--args', '--mode', '--api-type', '--max-calls', '--max-steps', '--timeout-seconds', '--poll-seconds'].includes(option))
      throw new Error(`Unknown option: ${option}`);
    if (!argv[i + 1]) throw new Error(`Missing value for ${option}`);
    values.set(option, argv[++i]);
  }
  const tool = values.get('--tool');
  if (!tool || !/^[a-z][a-z0-9_]*$/.test(tool)) throw new Error('--tool must be an Android Agent tool name');
  let args;
  try { args = JSON.parse(values.get('--args') ?? '{}'); }
  catch { throw new Error('--args must be a JSON object'); }
  if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error('--args must be a JSON object');
  const mode = values.get('--mode') ?? 'automatic';
  const apiType = values.get('--api-type') ?? 'chat_completions';
  if (!['automatic', 'request'].includes(mode)) throw new Error('--mode must be automatic or request');
  if (!['chat_completions', 'responses'].includes(apiType)) throw new Error('--api-type must be chat_completions or responses');
  const integer = (name, fallback, min, max) => {
    const raw = values.get(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be ${min}-${max}`);
    return parsed;
  };
  const timeoutSeconds = integer('--timeout-seconds', 180, 30, 3600);
  return {
    tool, args, mode, apiType,
    maxCalls: integer('--max-calls', 8, 1, 200),
    maxSteps: integer('--max-steps', 6, 1, 100),
    timeoutSeconds,
    pollSeconds: integer('--poll-seconds', timeoutSeconds + 30, 15, 3660)
  };
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function launchCredentials() {
  requiredEnv('NEXUS_LIVE_LAUNCH_FILE');
  const script = `Add-Type -AssemblyName System.Security
$bytes = [IO.File]::ReadAllBytes($env:NEXUS_LIVE_LAUNCH_FILE)
[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))`;
  let raw;
  try {
    raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      {encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']}).trim();
  } catch {
    throw new Error('Unable to decrypt NEXUS_LIVE_LAUNCH_FILE for the current Windows user');
  }
  let launch;
  try { launch = new URL(JSON.parse(raw)); }
  catch { throw new Error('NEXUS_LIVE_LAUNCH_FILE does not contain a valid launch URL'); }
  if (launch.protocol !== 'http:' || launch.hostname !== '127.0.0.1' || !launch.hash.startsWith('#bootstrap='))
    throw new Error('Launch URL is not a local NexusRoom Host URL');
  return {base: launch.origin, token: decodeURIComponent(launch.hash.slice('#bootstrap='.length))};
}

function redact(value, secrets = [], limit = 4000) {
  let output = String(value ?? '');
  for (const secret of secrets.filter(Boolean)) output = output.split(secret).join('[redacted]');
  output = output.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|authorization|password|secret)["']?\s*[:=]\s*)["']?[^"',\s}\]]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^@/\s]+@/gi, '$1[redacted]@')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b1[3-9]\d{9}\b/g, '[phone]');
  return output.length > limit ? `${output.slice(0, limit)}...[truncated]` : output;
}

function hostClient(base, token, secrets) {
  let roomId = '';
  return {
    selectRoom(id) { roomId = id; },
    async api(path, body, method = body === undefined ? 'GET' : 'POST', overrideRoom = roomId) {
      const headers = {Authorization: `Bearer ${token}`, 'X-Nexus-Request': '1'};
      if (overrideRoom) headers['X-Nexus-Room'] = overrideRoom;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(base + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(45000)
      });
      const value = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`Host HTTP ${response.status}: ${redact(value?.title ?? 'request failed', secrets, 300)}`);
      return value;
    }
  };
}

async function selectDevice(client) {
  const deviceId = process.env.NEXUS_LIVE_DEVICE_ID?.trim() || process.env.DEVICE_ID?.trim();
  const name = process.env.NEXUS_LIVE_DEVICE_NAME?.trim();
  if (!deviceId && !name) throw new Error('NEXUS_LIVE_DEVICE_NAME or NEXUS_LIVE_DEVICE_ID is required');
  const root = await client.api('/api/state');
  const specifiedRoom = process.env.NEXUS_AUDIT_ROOM_ID?.trim();
  const roomIds = specifiedRoom ? [specifiedRoom] : root.rooms.map(room => room.id);
  const matches = [];
  for (const roomId of roomIds) {
    const state = await client.api('/api/state', undefined, 'GET', roomId);
    for (const device of state.devices ?? []) {
      if (deviceId ? device.id === deviceId : device.name === name) matches.push({roomId, device});
    }
  }
  if (matches.length !== 1) throw new Error(`Expected one matching device; found ${matches.length}. Set NEXUS_LIVE_DEVICE_ID and NEXUS_AUDIT_ROOM_ID if needed`);
  const found = matches[0];
  if (!found.device.online) throw new Error('Selected phone is offline');
  if (!found.device.permissions?.agent) throw new Error('Selected phone has not granted Agent access for this room');
  if (found.device.activity === 'busy') throw new Error('Selected phone is busy in another room');
  client.selectRoom(found.roomId);
  return found.device;
}

function auditPrompt(tool, args) {
  return `这是受控的单工具审计。请只调用手机工具 ${tool} 一次，参数严格使用以下 JSON：${JSON.stringify(args)}。不要调用其他工具，也不要重复调用。收到工具结果后，简要说明工具是否成功，并给出可核查的结果摘要；若工具报错，请如实报告错误。`;
}

function eventView(event, secrets) {
  return {
    kind: event.kind,
    tool: event.tool || undefined,
    step: event.step,
    text: redact(event.text, secrets, 500),
    errorType: event.errorType || undefined
  };
}

function summarize(run, tool, secrets) {
  const events = (run.events ?? []).map(event => eventView(event, secrets));
  const started = events.filter(event => event.kind === 'tool' && event.tool === tool).length;
  const finished = events.filter(event => event.kind === 'status' && event.tool === tool);
  const failures = finished.filter(event => /失败|failed|error/i.test(event.text)).length;
  const otherTools = [...new Set(events.filter(event => event.tool && event.tool !== tool).map(event => event.tool))];
  return {
    status: run.status,
    verified: run.status === 'completed' && started === 1 && finished.length === 1 && failures === 0 && otherTools.length === 0,
    targetStarted: started,
    targetFinished: finished.length,
    targetFailures: failures,
    otherTools,
    events,
    result: redact(run.result, secrets)
  };
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForRun(client, id, pollSeconds, secrets) {
  const deadline = Date.now() + pollSeconds * 1000;
  const announced = new Set();
  while (Date.now() < deadline) {
    const runs = await client.api('/api/agent/runs');
    const run = runs.find(item => item.id === id);
    if (!run) throw new Error('Agent run disappeared from Host');
    for (const event of run.events ?? []) {
      if (event.kind !== 'permission_required' || announced.has(event.requestId)) continue;
      announced.add(event.requestId);
      console.log(JSON.stringify({phase: 'awaiting_approval', tool: event.tool, text: redact(event.text, secrets, 300)}));
    }
    if (['completed', 'failed', 'cancelled'].includes(run.status)) return run;
    await pause(1000);
  }
  throw new Error(`Agent run did not reach a terminal state within ${pollSeconds} seconds`);
}

async function main() {
  const selected = options(process.argv.slice(2));
  if (selected.help) { console.log(usage); return; }
  const apiKey = requiredEnv('NEXUS_AUDIT_API_KEY');
  const apiUrl = requiredEnv('NEXUS_AUDIT_API_URL');
  const model = requiredEnv('NEXUS_AUDIT_MODEL');
  const {base, token} = launchCredentials();
  const secrets = [apiKey, token];
  const client = hostClient(base, token, secrets);
  const report = {tool: selected.tool, mode: selected.mode, profileCreated: false, connectionTested: false, profileDeleted: false};
  let profileId = '';
  let runId = '';
  let terminal = false;
  try {
    const device = await selectDevice(client);
    report.device = {id: device.id, name: device.name};
    const profile = await client.api('/api/settings/profiles', {
      name: `Live audit ${selected.tool} ${Date.now()}`.slice(0, 80),
      apiType: selected.apiType, apiUrl, model, apiKey,
      maxCalls: selected.maxCalls, maxSteps: selected.maxSteps, timeoutSeconds: selected.timeoutSeconds
    });
    profileId = profile.id;
    report.profileCreated = true;
    const check = await client.api('/api/settings/test', {profileId});
    report.connectionTested = check?.ok === true;
    report.connectionReply = redact(check?.reply, secrets, 300);
    if (!report.connectionTested) throw new Error('Model connection test did not report ok=true');
    const started = await client.api('/api/agent/runs', {
      deviceId: device.id,
      profileId,
      mode: selected.mode,
      task: auditPrompt(selected.tool, selected.args)
    });
    runId = started.id;
    report.runId = runId;
    const run = await waitForRun(client, runId, selected.pollSeconds, secrets);
    terminal = true;
    Object.assign(report, summarize(run, selected.tool, secrets));
  } catch (error) {
    report.status ??= 'audit_error';
    report.error = redact(error.message, secrets, 500);
  } finally {
    if (runId && !terminal) {
      try { await client.api(`/api/agent/runs/${encodeURIComponent(runId)}`, undefined, 'DELETE'); report.runCancelled = true; }
      catch (error) { report.cancelError = redact(error.message, secrets, 300); }
    }
    if (profileId) {
      try { await client.api(`/api/settings/profiles/${encodeURIComponent(profileId)}`, undefined, 'DELETE'); report.profileDeleted = true; }
      catch (error) { report.cleanupError = redact(error.message, secrets, 300); }
    }
  }
  console.log(JSON.stringify(report));
  if (!report.verified || !report.profileDeleted) process.exitCode = 1;
}

main().catch(error => {
  console.error(JSON.stringify({status: 'setup_error', error: redact(error.message, [process.env.NEXUS_AUDIT_API_KEY])}));
  process.exitCode = 1;
});
