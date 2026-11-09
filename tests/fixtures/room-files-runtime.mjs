import { createInterface } from 'node:readline'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const patch = readFileSync(process.argv[process.argv.indexOf('--patch') + 1], 'utf8')
const pluginPath = patch.match(/- id: nexusroom-room-files\s+name: '((?:[^']|'')+)'/u)?.[1]?.replaceAll("''", "'")
if (!pluginPath) throw new Error('Room-file plugin was not rendered into the SDK patch')
const { apply } = await import(pathToFileURL(pluginPath))
const tools = new Map()
apply({ tools: { register: definition => tools.set(definition.name, definition) }, systemPrompt: { section() {} } },
  { pipeName: process.env.NEXUSROOM_ROOM_FILES_PIPE })
const controller = new AbortController()
let sessionId = ''
const write = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
const event = (type, data) => write({ method: 'session.event', params: { sessionId, event: { type, data } } })
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') write({ id: request.id, result: { serverInfo: { name: 'room-files-contract', version: 'fixture' } } })
  else if (request.method === 'session/prompt') {
    sessionId = request.params.sessionId
    const task = JSON.parse(request.params.contentBlocks[0].text)
    writeFileSync(resolve(process.cwd(), sessionId + '.bridge.json'), JSON.stringify({ pid: process.pid, pipeName: process.env.NEXUSROOM_ROOM_FILES_PIPE }))
    write({ method: 'session.status', params: { sessionId, status: 'running' } })
    write({ id: request.id, result: { messageId: 'fixture' } })
    const execute = async () => {
      let value, failure
      const attempts = []
      for (let attempt = 0; attempt <= (task.retry ? 1 : 0); attempt++) {
        const callId = 'room-file-fixture-call-' + attempt
        event('tool/call', { callId, name: task.tool, arguments: JSON.stringify(task.arguments || {}) })
        try { value = await tools.get(task.tool).execute(task.arguments || {}, { signal: controller.signal, callId }); failure = null }
        catch (error) { failure = { message: error.message, code: error.code || 'FIXTURE_ERROR' } }
        attempts.push({value,failure})
        event('tool/result', { callId, message: { toolCallId: callId, content: [{ type: 'text', text: value || failure?.message || '' }], isError: !!failure }, error: failure || null })
        if (!failure) break
      }
      writeFileSync(resolve(process.cwd(), sessionId + '.transfer.json'), JSON.stringify({ value, failure }))
      // A normal completed turn after an unsuccessful send must still fail
      // the Host task; the transfer result is authoritative.
      event('assistant/message', { message: { content: [{ type: 'text', text: task.claimSuccess ? 'COMPLETED' : value || failure?.message || '' }] } })
      event('turn/end', { reason: { kind: failure && !task.claimSuccess ? 'error' : 'completed', ...(failure && !task.claimSuccess ? { error: failure } : {}) } })
      write({ method: 'session.status', params: { sessionId, status: 'idle' } })
    }
    execute().catch(error => { process.stderr.write(error.message); process.exit(1) })
  } else if (request.method === 'shutdown') {
    controller.abort(new Error('Host shutdown'))
    write({ id: request.id, result: {} })
    setTimeout(() => process.exit(0), 30)
  }
})
