import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../src/NexusRoom.Host/Agent/harness-room-files.mjs'

function definitions() {
  const tools = new Map()
  const prompts = []
  apply({ tools: { register: definition => tools.set(definition.name, definition) },
    systemPrompt: { section: value => prompts.push(value) } }, { pipeName: 'NexusRoom-RoomFiles-' + 'a'.repeat(32) })
  return { tools, prompts }
}

test('room file tools expose a Windows path and explicit phone selection with a receipt contract', () => {
  const { tools, prompts } = definitions()
  assert.deepEqual([...tools.keys()], ['list_room_devices', 'send_file_to_phone', 'arrange_communication'])
  const sending = tools.get('send_file_to_phone')
  assert.deepEqual(sending.parameters.required, ['path'])
  assert.equal(sending.parameters.additionalProperties, false)
  assert.ok(sending.parameters.properties.deviceId)
  assert.match(sending.description, /SHA-256/)
  assert.match(prompts[0].text, /verified=true/)
  assert.match(prompts[0].text, /send_file_to_phone/)
  assert.deepEqual(sending.output.render({}, 'receipt'), [{ type: 'text', text: 'receipt' }])
})

test('communication tool fixes actions to requests and exposes no acceptance or caller override', async () => {
  const { tools, prompts } = definitions()
  const arranging = tools.get('arrange_communication')
  assert.deepEqual(arranging.parameters.required, ['action'])
  assert.deepEqual(arranging.parameters.properties.action.enum, ['call', 'meeting'])
  assert.equal(arranging.parameters.additionalProperties, false)
  assert.ok(arranging.parameters.properties.inviteeIds)
  assert.match(prompts[1].text, /never|Never/)
  assert.match(arranging.description, /never turns on the microphone/)
  for (const args of [null, [], {}, {action:'accept'}, {action:'call'}, {action:'call',targetId:'phone',callerId:'fake'},
    {action:'meeting',visibility:'hidden'}, {action:'meeting',inviteeIds:['a\u0000b']}, {action:'meeting',targetId:'phone'},
    {action:'call',targetId:'phone',inviteeIds:['another']}])
    await assert.rejects(arranging.execute(args, {signal:new AbortController().signal}))
})

test('invalid arguments are rejected before connecting to the Host or sending files', async () => {
  const { tools } = definitions()
  const signal = new AbortController().signal
  for (const args of [null, [], {}, {path:''}, {path:7}, {path:'a\u0000b'}, {path:'a',roomId:'other'}, {path:'a',deviceId:7}])
    await assert.rejects(tools.get('send_file_to_phone').execute(args, { signal }))
  await assert.rejects(tools.get('list_room_devices').execute({mode:'automatic'}, { signal }))
})

test('a cancelled tool never connects, and a missing per-task pipe fails activation', async () => {
  const { tools } = definitions()
  const controller = new AbortController()
  controller.abort(new Error('cancelled before dispatch'))
  await assert.rejects(tools.get('send_file_to_phone').execute({path:'test.txt'}, {signal:controller.signal}), /cancelled before dispatch/)
  for (const config of [null, {}, {pipeName:'arbitrary'}, {pipeName:'NexusRoom-Approval-' + 'a'.repeat(32)}])
    assert.throws(() => apply({}, config), /pipe is missing/)
})
