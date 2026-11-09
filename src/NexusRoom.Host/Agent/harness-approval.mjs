import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'

const outcomes = new Set(['allowed-once', 'rejected', 'cancelled', 'unavailable'])

function callArguments(request) {
  if (request.callId === undefined) return null
  const events = request.agent.session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event.type === 'tool/call' && event.data.callId === request.callId) {
      return JSON.parse(event.data.arguments)
    }
  }
  return null
}

function ask(pipeName, request) {
  return new Promise((resolve) => {
    if (request.signal?.aborted) { resolve('cancelled'); return }
    const id = randomUUID()
    const message = JSON.stringify({ id, toolName: request.toolName, callId: request.callId ?? null,
      reason: request.reason ?? request.displayReason?.en ?? '', arguments: callArguments(request) })
    if (Buffer.byteLength(message, 'utf8') > 60 * 1024) { resolve('unavailable'); return }

    const socket = createConnection('\\\\.\\pipe\\' + pipeName)
    let settled = false
    let response = ''
    const finish = (outcome) => {
      if (settled) return
      settled = true
      request.signal?.removeEventListener('abort', abort)
      socket.destroy()
      resolve(outcome)
    }
    const abort = () => finish('cancelled')
    request.signal?.addEventListener('abort', abort, { once: true })
    socket.setTimeout(185_000, () => finish('unavailable'))
    socket.on('connect', () => socket.write(message + '\n'))
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8')
      if (response.length > 4096) { finish('unavailable'); return }
      const newline = response.indexOf('\n')
      if (newline < 0) return
      try {
        const answer = JSON.parse(response.slice(0, newline))
        finish(answer.id === id && outcomes.has(answer.outcome) ? answer.outcome : 'unavailable')
      } catch { finish('unavailable') }
    })
    socket.on('error', () => finish('unavailable'))
    socket.on('close', () => finish('unavailable'))
  })
}

export function apply(ctx, config) {
  ctx.on('approval/request', (request, next) => {
    if (process.platform !== 'win32' || !config?.pipeName) return next()
    try { return ask(config.pipeName, request) }
    catch { return Promise.resolve('unavailable') }
  })
}
