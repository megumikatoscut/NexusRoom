import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

let sessionId = '';
let trace;
let scenario = '';
const write = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const event = (type, data) => write({ method: 'session.event', params: { sessionId, event: { type, data } } });
const save = () => writeFileSync(resolve(process.cwd(), `${sessionId}.json`), JSON.stringify(trace));
const finish = reason => {
  event('assistant/message', { message: { content: [{ type: 'text', text: 'CONTRACT_OK' }] } });
  if (reason) event('turn/end', { reason: { kind: reason } });
  write({ method: 'session.status', params: { sessionId, status: 'idle' } });
};

createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    trace = { pid: process.pid, cwd: process.cwd(), initialize: request.params,
      execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS, browserPath: process.env.PLAYWRIGHT_BROWSERS_PATH,
      primaryRuntimeAvailable: Boolean(process.env.DSH_BUNDLED_PRIMARY_RUNTIME && existsSync(resolve(process.env.DSH_BUNDLED_PRIMARY_RUNTIME, 'runtime.json'))),
      api: process.env.NEXUSROOM_HARNESS_API, baseUrl: process.env.NEXUSROOM_HARNESS_BASE_URL,
      keyMatches: process.env.NEXUSROOM_HARNESS_API_KEY === 'contract-key',
      permissionMode: process.env.DSH_PERMISSION_MODE, home: process.env.DSH_HOME,
      maxCalls: process.env.NEXUSROOM_HARNESS_MAX_CALLS, maxSteps: process.env.NEXUSROOM_HARNESS_MAX_STEPS,
      roomFilesBridgePresent: /^NexusRoom-RoomFiles-[a-f0-9]{32}$/.test(process.env.NEXUSROOM_ROOM_FILES_PIPE || ''),
      roomFilesPluginPresent: /- id: nexusroom-room-files\s+name: '(?!__)[^']+harness-room-files\.mjs'/.test(readFileSync(process.argv[process.argv.indexOf('--patch') + 1], 'utf8')),
      shutdown: false };
    process.stderr.write('ordinary diagnostic on stderr\n');
    write({ id: request.id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: 'fixture' } } });
  } else if (request.method === 'session/prompt') {
    sessionId = request.params.sessionId;
    scenario = request.params.contentBlocks[0].text;
    save();
    write({ method: 'session.status', params: { sessionId, status: 'running' } });
    write({ id: request.id, result: { messageId: 'fixture-message' } });
    setTimeout(() => {
      if (scenario === 'hold') {
        event('tool/call', { callId: 'fixture-call', name: 'pwsh', arguments: '{"command":"Start-Sleep 90"}' });
      } else if (scenario === 'invalid-stdout') {
        process.stdout.write('this is not JSON-RPC\n');
      } else if (scenario === 'secret') {
        event('assistant/message', { message: { content: [{ type: 'text', text: process.env.NEXUSROOM_HARNESS_API_KEY }] } });
        event('turn/end', { reason: { kind: 'completed' } });
        write({ method: 'session.status', params: { sessionId, status: 'idle' } });
      } else if (scenario === 'limit' || scenario === 'limit-flat') {
        event('tool/call', { callId: 'fixture-call', name: 'pwsh', arguments: '{"command":"Get-Location"}' });
        event('tool/result', { ...(scenario === 'limit-flat' ? { callId: 'fixture-call' } : {}),
          message: { ...(scenario === 'limit' ? { toolCallId: 'fixture-call' } : {}),
            content: [{ type: 'text', text: 'tool limit reached' }], isError: true },
          error: { code: 'NEXUSROOM_LIMIT' } });
        finish('completed');
      } else if (scenario === 'approval-denied') {
        event('approval/decided', { id: 'fixture-approval', outcome: 'rejected' });
        finish('completed');
      } else if (scenario === 'error') {
        event('turn/end', { reason: { kind: 'error', error: { message: 'provider rejected request', code: 'PROVIDER_ERROR' } } });
        write({ method: 'session.status', params: { sessionId, status: 'idle' } });
      } else finish(scenario === 'no-turn-end' ? null : 'completed');
    }, 30);
  } else if (request.method === 'shutdown') {
    if (trace && sessionId) { trace.shutdown = true; save(); }
    write({ id: request.id, result: {} });
    setTimeout(() => process.exit(0), 800);
  }
});
