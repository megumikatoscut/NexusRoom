import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'

export const name = 'nexusroom-room-files'
export const inject = ['tools', 'systemPrompt']

const descriptions = {
  list_room_devices: 'List this Windows PC and Android phones in the current NexusRoom room, with deviceId, name, model, communicationOnline, busy, and file/Agent permissions. selfId is this Windows PC. Use exact deviceId to disambiguate duplicate device names or models.',
  send_file_to_phone: 'Send a Windows file directly to an Android phone through this NexusRoom room\'s file transfer. Pass the user-provided file path directly; relative paths resolve against the PC working directory. The Host validates existence, file type, size and read access, so a send-only request requires no shell, read, glob or metadata pre-check. deviceId is optional only when exactly one phone is connected; use list_room_devices when phone selection is needed. The Host imports the bytes and returns success only after the phone saves the file in Download/NexusRoom and acknowledges its matching SHA-256. Request mode asks for approval of this exact file and phone. Use this tool whenever the user asks to send a PC file to their phone.',
  arrange_communication: 'Arrange a NexusRoom private audio call or public/private video meeting as this Windows PC. For call, provide action=call and targetId. For meeting, provide action=meeting, title, visibility=public/private, and optional inviteeIds. IDs or exact device names/models are accepted; ambiguous names are rejected. Query list_room_devices when needed. This tool sends requests and invitations, never accepts on behalf of another device and never turns on the microphone, camera or screen capture. The user must enable audio in NexusRoom after the request is sent; the recipient must explicitly accept. Report that requests were sent, not that anyone accepted or that media is connected. Request mode requires approval.',
}

function validate(tool, args) {
  if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error('Tool arguments must be an object')
  const keys = tool === 'send_file_to_phone' ? ['path', 'deviceId'] : tool === 'arrange_communication' ? ['action', 'targetId', 'title', 'visibility', 'inviteeIds'] : []
  if (Object.keys(args).some(key => !keys.includes(key))) throw new Error('Unknown room-file argument')
  if (tool === 'send_file_to_phone') {
    if (typeof args.path !== 'string' || !args.path.trim() || args.path.length > 32768 || /[\u0000-\u001f]/u.test(args.path))
      throw new Error('path must be an existing Windows file path')
    if (args.deviceId !== undefined && (typeof args.deviceId !== 'string' || args.deviceId.length > 100))
      throw new Error('deviceId must come from list_room_devices')
  }
  if (tool === 'arrange_communication') {
    if (!['call', 'meeting'].includes(args.action)) throw new Error('action must be call or meeting')
    for (const key of ['targetId', 'title', 'visibility'])
      if (args[key] !== undefined && (typeof args[key] !== 'string' || args[key].length > (key === 'title' ? 80 : 100) || /[\u0000-\u001f]/u.test(args[key]))) throw new Error('Invalid ' + key)
    if (args.visibility !== undefined && !['public', 'private'].includes(args.visibility)) throw new Error('Invalid visibility')
    if (args.inviteeIds !== undefined && (!Array.isArray(args.inviteeIds) || args.inviteeIds.length > 32 || args.inviteeIds.some(value => typeof value !== 'string' || !value.trim() || value.length > 100 || /[\u0000-\u001f]/u.test(value)))) throw new Error('Invalid inviteeIds')
    if (args.action === 'call' && (!args.targetId?.trim() || args.title || args.visibility || args.inviteeIds?.length)) throw new Error('A call requires only targetId')
    if (args.action === 'meeting' && args.targetId) throw new Error('A meeting uses inviteeIds')
  }
}

function callHost(pipeName, tool, args, exec) {
  return new Promise((resolve, reject) => {
    if (exec.signal.aborted) { reject(exec.signal.reason ?? new Error('Task cancelled')); return }
    const id = randomUUID()
    const message = JSON.stringify({ id, tool, arguments: args, callId: exec.callId ?? '' })
    if (Buffer.byteLength(message, 'utf8') > 60 * 1024) { reject(new Error('Room-file arguments exceed the limit')); return }
    const socket = createConnection('\\\\.\\pipe\\' + pipeName)
    socket.setEncoding('utf8')
    let settled = false
    let response = ''
    const finish = (error, value) => {
      if (settled) return
      settled = true
      exec.signal.removeEventListener('abort', abort)
      socket.destroy()
      if (error) reject(error)
      else resolve(value)
    }
    const abort = () => finish(exec.signal.reason ?? new Error('Task cancelled'))
    exec.signal.addEventListener('abort', abort, { once: true })
    socket.setTimeout(3600_000, () => finish(new Error('NexusRoom file transfer timed out')))
    socket.on('connect', () => socket.write(message + '\n'))
    socket.on('data', chunk => {
      response += chunk.toString('utf8')
      if (Buffer.byteLength(response, 'utf8') > 256 * 1024) { finish(new Error('NexusRoom response exceeds the limit')); return }
      const newline = response.indexOf('\n')
      if (newline < 0) return
      try {
        const answer = JSON.parse(response.slice(0, newline))
        if (answer.id !== id) throw new Error('NexusRoom response ID mismatch')
        if (answer.error) {
          finish(Object.assign(new Error(answer.error.message || 'Room file transfer failed'), {
            code: tool === 'arrange_communication' ? answer.error.status === 403 ? 'NEXUSROOM_COMMUNICATION_DENIED' : 'NEXUSROOM_COMMUNICATION' : answer.error.status === 403 ? 'NEXUSROOM_FILE_DENIED' : 'NEXUSROOM_FILE_TRANSFER',
          }))
        } else if (answer.result !== undefined) finish(null, JSON.stringify(answer.result))
        else finish(new Error('NexusRoom response is incomplete'))
      } catch (error) { finish(error) }
    })
    socket.on('error', () => finish(new Error('NexusRoom room-file bridge is unavailable')))
    socket.on('close', () => finish(new Error('NexusRoom room-file bridge disconnected')))
  })
}

export function apply(ctx, config) {
  if (typeof config?.pipeName !== 'string' || !/^NexusRoom-RoomFiles-[a-f0-9]{32}$/u.test(config.pipeName))
    throw new Error('NexusRoom room-file pipe is missing')
  for (const tool of Object.keys(descriptions)) {
    ctx.tools.register({
      name: tool,
      description: descriptions[tool],
      parameters: {
        type: 'object',
        properties: tool === 'send_file_to_phone' ? {
          path: { type: 'string', description: 'File path, such as ./test.txt. Relative paths use the PC working directory.' },
          deviceId: { type: 'string', description: 'Exact phone deviceId from list_room_devices; required when several phones are connected.' },
        } : tool === 'arrange_communication' ? {
          action: {type: 'string', enum: ['call', 'meeting']},
          targetId: {type: 'string', description: 'Call recipient exact deviceId or unique exact name/model.'},
          title: {type: 'string', description: 'Meeting title, at most 80 characters.'},
          visibility: {type: 'string', enum: ['public', 'private'], description: 'Meeting visibility; defaults to private.'},
          inviteeIds: {type: 'array', items: {type: 'string'}, maxItems: 32, description: 'Meeting invitation targets: exact IDs or unique exact names/models.'},
        } : {},
        required: tool === 'send_file_to_phone' ? ['path'] : tool === 'arrange_communication' ? ['action'] : [],
        additionalProperties: false,
      },
      timeoutMs: 3600_000,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) {
        validate(tool, args)
        return callHost(config.pipeName, tool, args, exec)
      },
    })
  }
  ctx.systemPrompt.section({
    name: 'nexusroom:room-file-transfer',
    order: 850,
    text: 'You are the Windows PC Agent in a NexusRoom room. When a user only asks to send a supplied Windows file path to a phone, call send_file_to_phone directly with that path. Use list_room_devices if needed to select the phone; when several phones are connected, obtain a specific deviceId. The Host validates the path, existence, file type, size and read access, performs the room file transfer, and verifies the phone receipt. Do not first use pwsh, read, glob, filesystem search or metadata commands to inspect a supplied path for a send-only request. No manual import or server credential is needed. Do not diagnose or change Windows permissions for a send-only request. An unrelated shell sandbox error does not establish that room file transfer needs permission repair; use the dedicated transfer tool and report its actual outcome. Do not claim that a file was delivered until send_file_to_phone succeeds with verified=true. If the transfer tool fails, report its actual failure. User requests may name an absolute Windows path outside the working directory; the tool handles the selected request/automatic mode on the Host.',
  })
  ctx.systemPrompt.section({
    name: 'nexusroom:communications', order: 851,
    text: 'Use arrange_communication for requests such as 给某台设备打电话 or 发起私密会议并邀请某些设备. You are the PC target and the caller/host is fixed to this Windows PC. Use list_room_devices to identify room devices, then action=call with targetId or action=meeting with title, visibility and inviteeIds. Never use a shell, browser automation, remote control, or API credentials to arrange a call or meeting when this tool is available. Never invent an accepted invitation or enable microphones/cameras/screens without user interaction. Success confirms only that the request or invitations were sent. Tell the user to click the NexusRoom microphone/audio button to join media, and wait for recipients to accept. If a name or model matches several devices, ask for a specific device rather than guessing.',
  })
}
