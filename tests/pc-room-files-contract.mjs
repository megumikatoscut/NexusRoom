import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, open } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConnection } from 'node:net'
import https from 'node:https'
import WebSocket from 'ws'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const uiPort = Number(process.env.NEXUS_ROOM_FILE_UI_PORT || 18720)
const devicePort = uiPort + 1
const data = await mkdtemp(resolve(root, '.local/pc-room-files-contract-'))
const runtime = resolve(data, 'runtime')
const workspace = resolve(data, 'workspace')
await mkdir(resolve(runtime, 'apps/cli/lib'), { recursive: true })
await mkdir(workspace, { recursive: true })
await copyFile(resolve(root, 'tests/fixtures/room-files-runtime.mjs'), resolve(runtime, 'apps/cli/lib/bin.js'))
const file = resolve(workspace, '房间传输 test.txt')
const bytes = Buffer.from('NexusRoom PC room-file contract 你好\n')
const sourceFile = await open(file, 'w'); await sourceFile.writeFile(bytes); await sourceFile.close()
const base = 'http://127.0.0.1:' + uiPort
const child = spawn('dotnet', [process.env.NEXUS_TEST_HOST_DLL || resolve(root, 'src/NexusRoom.Host/bin/Debug/net10.0-windows/NexusRoom.Host.dll'), '--headless'], {
  cwd: root, windowsHide: true,
  env: { ...process.env, NEXUS_DATA_DIR: data, NEXUS_UI_PORT: String(uiPort), NEXUS_DEVICE_PORT: String(devicePort),
    NEXUS_DISCOVERY_PORT: String(uiPort + 2), NEXUS_DISABLE_MDNS: '1', NEXUS_HARNESS_DIR: runtime },
  stdio: ['ignore', 'ignore', 'pipe'],
})
let diagnostics = ''
child.stderr.on('data', chunk => { diagnostics += chunk.toString() })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(40) }
  throw new Error('Room-file contract check timed out')
}
let token = '', roomId, targetId, profile
async function request(path, body, method = body === undefined ? 'GET' : 'POST', selectedRoom = roomId) {
  const response = await fetch(base + path, { method,
    headers: { Authorization: 'Bearer ' + token, 'X-Nexus-Request': '1', 'Content-Type': 'application/json',
      ...(selectedRoom ? {'X-Nexus-Room':selectedRoom} : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, value: await response.json() }
}
async function api(path, body, method, selectedRoom) {
  const result = await request(path, body, method, selectedRoom)
  assert.equal(result.status, 200, JSON.stringify(result.value)); return result.value
}
function mobile(path, body, credential = '') {
  return new Promise((resolve, reject) => {
    const req = https.request('https://127.0.0.1:' + devicePort + path, { rejectUnauthorized: false,
      method: body === undefined ? 'GET' : 'POST', headers: { Authorization:'Bearer ' + credential,
        ...(body === undefined ? {} : {'Content-Type':'application/json'}) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const buffer = Buffer.concat(chunks)
        if (res.statusCode !== 200) { reject(new Error('Mobile HTTP ' + res.statusCode)); return }
        resolve(res.headers['content-type']?.includes('application/json') ? JSON.parse(buffer.toString()) : buffer)
      })
    })
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
const phones = []
async function joinPhone(name, selectedRoom = roomId) {
  const invitation = await api('/api/invitation', undefined, 'GET', selectedRoom)
  const member = await mobile('/device/join', { roomId:invitation.roomId,password:invitation.password,
    name,version:'contract',physicalId:name })
  const socket = new WebSocket('wss://127.0.0.1:' + devicePort + '/device/ws', { rejectUnauthorized:false,
    headers:{Authorization:'Bearer ' + member.token} })
  const phone = { ...member, socket, received:[], mode:'normal', held:[] }
  phones.push(phone)
  const send = value => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)) }
  phone.permissions = { files:true, agent:true, control:false, screen:false, clipboard:false }
  phone.updatePermissions = value => { phone.permissions = {...phone.permissions,...value}; send({type:'permissions',permissions:phone.permissions}) }
  phone.reply = (message, result) => send({type:'result',id:message.id,result})
  socket.on('message', async raw => {
    const message = JSON.parse(raw.toString())
    if (message.type !== 'command') return
    phone.received.push(message)
    if (message.tool.startsWith('control_')) { phone.reply(message,{ok:true}); return }
    if (message.tool !== 'receive_file') { send({type:'result',id:message.id,error:'unexpected tool'}); return }
    if (phone.mode === 'hold') { phone.held.push(message); return }
    try {
      assert.equal(message.arguments.agent,true)
      assert.ok(message.lease)
      assert.equal(message.arguments.taskId,undefined, 'PC run ID must not be sent as an Android-local Agent task ID')
      const downloaded = await mobile('/device/files/' + message.arguments.fileId, undefined, member.token)
      assert.deepEqual(downloaded,bytes)
      const hash = createHash('sha256').update(downloaded).digest('hex')
      const badHash = phone.mode === 'wrong-sha' || phone.mode === 'wrong-sha-once'
      if (phone.mode === 'wrong-sha-once') phone.mode = 'normal'
      phone.reply(message,{ok:true,sha256:badHash ? '0'.repeat(64) : hash,
        savedTo:'Download/NexusRoom/' + message.arguments.name})
    } catch (error) { send({type:'result',id:message.id,error:error.message}) }
  })
  await once(socket,'open')
  send({type:'hello',battery:100,width:1080,height:1920,permissions:phone.permissions})
  await until(async () => (await api('/api/state',undefined,'GET',selectedRoom)).devices.some(d => d.id === member.deviceId && d.online && d.permissions.agent))
  return phone
}
const start = (args, mode = 'automatic', extra = {}) => api('/api/agent/runs', {targetId,profileId:profile.id,workspacePath:workspace,
  mode,task:JSON.stringify({tool:'send_file_to_phone',arguments:args,...extra})})
const done = id => until(async () => (await api('/api/agent/runs')).find(run => run.id === id && run.status !== 'running'))
const pending = id => until(async () => (await api('/api/state')).approvals.find(item => item.runId === id))
const sends = phone => phone.received.filter(item => item.tool === 'receive_file')
let count = 0, failures = 0
async function check(name, action) {
  try { await action(); count++; console.log('PASS ' + name) }
  catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message) }
}
try {
  await until(async () => { if (child.exitCode !== null) throw new Error('Contract Host startup failed');
    try { return (await fetch(base + '/health')).ok } catch { return false } })
  const launchPath = resolve(data, 'launch.dat').replaceAll("'", "''")
  const expression = "Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes('" + launchPath + "'),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))"
  const launch = JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',expression],
    {encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','ignore']}).trim())
  token = new URL(launch).hash.slice('#bootstrap='.length)
  roomId = (await api('/api/state')).room.id; targetId = 'pc:' + roomId
  profile = await api('/api/settings/profiles',{name:'Room-file fixture',apiType:'chat_completions',
    apiUrl:'https://api.example.test/v1/chat/completions',apiKey:'room-file-fixture-key',model:'contract',
    maxCalls:8,maxSteps:8,timeoutSeconds:120})
  const first = await joinPhone('PC room-file phone A')

  await check('automatic mode transfers exact Unicode file bytes, verifies SHA-256, and releases the PC lease', async () => {
    const before = sends(first).length
    const run = await done((await start({path:'房间传输 test.txt'})).id)
    assert.equal(run.status,'completed',run.result)
    const receipt = JSON.parse(run.events.find(e => e.kind === 'result' && e.tool === 'send_file_to_phone').text)
    assert.equal(receipt.verified,true); assert.equal(receipt.deviceId,first.deviceId)
    assert.equal(receipt.sha256,createHash('sha256').update(bytes).digest('hex'))
    assert.equal(receipt.savedTo,'Download/NexusRoom/房间传输 test.txt')
    assert.equal(sends(first).length,before + 1)
    assert.equal((await api('/api/state')).transfers.find(t => t.id === receipt.fileId).status,'completed')
    assert.ok(first.received.some(m => m.tool === 'control_acquire' && m.arguments.reason === 'pc-file:' + run.id))
    assert.equal(first.received.at(-1).tool,'control_release')
    assert.equal(run.events.some(e => e.kind === 'permission_required'),false)
  })
  await check('missing paths, directories and oversized files fail before sending or importing', async () => {
    const before = (await api('/api/state')).transfers.length
    const large = resolve(workspace,'oversized.bin'); const handle = await open(large,'w')
    try { await handle.truncate(512 * 1024 * 1024 + 1) } finally { await handle.close() }
    for (const path of [resolve(workspace,'absent.txt'),workspace,large]) {
      const run = await done((await start({path},'automatic', {claimSuccess:true})).id)
      assert.equal(run.status,'failed'); assert.ok(run.events.some(e => e.kind === 'error' && e.tool === 'send_file_to_phone'))
    }
    assert.equal((await api('/api/state')).transfers.length,before)
  })
  await check('request mode shows the exact phone and path, rejects another process on its pipe, and sends only once after approval', async () => {
    const before = sends(first).length
    const run = await start({path:file},'request'); const approval = await pending(run.id)
    assert.equal(approval.tool,'send_file_to_phone'); assert.equal(approval.deviceId,targetId)
    assert.equal(approval.arguments.path,file); assert.equal(approval.arguments.deviceId,first.deviceId)
    assert.equal(sends(first).length,before)
    const bridge = JSON.parse(await readFile(resolve(workspace,run.id + '.bridge.json'),'utf8'))
    await new Promise((resolve,reject) => {
      const socket = createConnection('\\\\.\\pipe\\' + bridge.pipeName)
      const timer = setTimeout(() => {socket.destroy();reject(new Error('Foreign process was not rejected'))},2000)
      socket.on('connect',()=>socket.write(JSON.stringify({id:'foreign',tool:'send_file_to_phone',arguments:{path:file}}) + '\n'))
      socket.on('data',()=>{clearTimeout(timer);socket.destroy();reject(new Error('Foreign process received bridge data'))})
      socket.on('error',()=>{}); socket.on('close',()=>{clearTimeout(timer);resolve()})
    })
    await api('/api/approvals/' + approval.id,{allow:true})
    assert.equal((await done(run.id)).status,'completed')
    assert.equal(sends(first).length,before + 1)
  })
  await check('request rejection and cancellation leave no transfer and revoke pending approval', async () => {
    const before = (await api('/api/state')).transfers.length
    const rejected = await start({path:file},'request'); const denial = await pending(rejected.id)
    await api('/api/approvals/' + denial.id,{allow:false}); assert.equal((await done(rejected.id)).status,'failed')
    const stopped = await start({path:file},'request'); await pending(stopped.id)
    await api('/api/agent/runs/' + stopped.id,undefined,'DELETE'); assert.equal((await done(stopped.id)).status,'cancelled')
    assert.equal((await api('/api/state')).transfers.length,before)
    assert.equal((await api('/api/state')).approvals.some(a => a.runId === stopped.id),false)
  })
  await check('permission revocation while approval is pending prevents import and delivery', async () => {
    const before = (await api('/api/state')).transfers.length
    const run = await start({path:file},'request'); const approval = await pending(run.id)
    first.updatePermissions({files:false})
    await until(async () => !(await api('/api/state')).devices.find(d => d.id === first.deviceId).permissions.files)
    await api('/api/approvals/' + approval.id,{allow:true}); assert.equal((await done(run.id)).status,'failed')
    assert.equal((await api('/api/state')).transfers.length,before)
    first.updatePermissions({files:true}); await until(async () => (await api('/api/state')).devices.find(d => d.id === first.deviceId).permissions.files)
  })
  const second = await joinPhone('PC room-file phone B')
  await check('multiple phones require an explicit deviceId and listing stays in the fixed room', async () => {
    const ambiguous = await done((await start({path:file})).id); assert.equal(ambiguous.status,'failed'); assert.match(ambiguous.result,/多台在线手机/)
    const listed = await api('/api/agent/runs',{targetId,profileId:profile.id,workspacePath:workspace,mode:'automatic',
      task:JSON.stringify({tool:'list_room_devices',arguments:{}})})
    const run = await done(listed.id); assert.equal(run.status,'completed')
    const devices = JSON.parse(run.result).devices
    assert.deepEqual(new Set(devices.map(d => d.deviceId)),new Set([targetId,first.deviceId,second.deviceId]))
    assert.equal((await done((await start({path:file,deviceId:second.deviceId})).id)).status,'completed')
  })
  const otherRoom = await api('/api/rooms',{name:'Room-file isolation room'})
  const outsider = await joinPhone('PC room-file outsider',otherRoom.id)
  await check('cross-room phone selection and attempts to override room or mode fail without sending', async () => {
    const before = sends(outsider).length
    for (const args of [{path:file,deviceId:outsider.deviceId},{path:file,deviceId:first.deviceId,roomId:otherRoom.id},
      {path:file,deviceId:first.deviceId,mode:'automatic'}])
      assert.equal((await done((await start(args,'request')).id)).status,'failed')
    assert.equal(sends(outsider).length,before)
  })
  await check('a wrong Android SHA-256 cannot complete the transfer or be overwritten by a claimed success', async () => {
    first.mode = 'wrong-sha'
    const run = await done((await start({path:file,deviceId:first.deviceId},'automatic',{claimSuccess:true})).id)
    assert.equal(run.status,'failed'); assert.match(run.result,/校验/)
    const id = sends(first).at(-1).arguments.fileId
    assert.equal((await api('/api/state')).transfers.find(t => t.id === id).status,'failed')
    first.mode = 'normal'
  })
  await check('retrying the same file within one task reuses its transfer ID and clears a recovered error', async () => {
    const before = (await api('/api/state')).transfers.length
    const countBefore = sends(first).length
    first.mode = 'wrong-sha-once'
    const run = await done((await start({path:file,deviceId:first.deviceId},'automatic',{retry:true})).id)
    assert.equal(run.status,'completed',run.result)
    const attempts = sends(first).slice(countBefore)
    assert.equal(attempts.length,2)
    assert.equal(attempts[0].arguments.fileId,attempts[1].arguments.fileId)
    assert.equal((await api('/api/state')).transfers.length,before + 1)
    assert.equal(JSON.parse(run.result).verified,true)
  })
  await check('Stop during delivery marks the transfer failed and promptly releases its lease', async () => {
    first.mode = 'hold'; const run = await start({path:file,deviceId:first.deviceId})
    await until(()=>first.held.length > 0)
    const held = first.held.shift()
    await api('/api/agent/runs/' + run.id,undefined,'DELETE'); assert.equal((await done(run.id)).status,'cancelled')
    const transfer = (await api('/api/state')).transfers.find(t => t.id === held.arguments.fileId)
    assert.equal(transfer.status,'failed'); assert.equal(first.received.at(-1).tool,'control_release')
    first.reply(held,{ok:true,sha256:held.arguments.sha256,savedTo:'late receipt'})
    first.mode = 'normal'
  })
  await check('permission revocation during delivery rejects even a correct late acknowledgement', async () => {
    first.mode = 'hold'; const run = await start({path:file,deviceId:first.deviceId})
    await until(()=>first.held.length > 0); const held = first.held.shift()
    first.updatePermissions({files:false})
    await until(async () => !(await api('/api/state')).devices.find(d => d.id === first.deviceId).permissions.files)
    first.reply(held,{ok:true,sha256:held.arguments.sha256,savedTo:'must not complete'})
    assert.equal((await done(run.id)).status,'failed')
    assert.equal((await api('/api/state')).transfers.find(t => t.id === held.arguments.fileId).status,'failed')
    first.updatePermissions({files:true}); first.mode = 'normal'
    await until(async () => (await api('/api/state')).devices.find(d => d.id === first.deviceId).permissions.files)
  })
  await check('disabling Windows Agent cancels pending file approval and prevents transmission', async () => {
    const before = sends(first).length
    const run = await start({path:file,deviceId:first.deviceId},'request'); await pending(run.id)
    await api('/api/settings/pc-agent',{enabled:false}); assert.equal((await done(run.id)).status,'cancelled')
    assert.equal(sends(first).length,before); assert.equal((await api('/api/state')).approvals.some(a => a.runId === run.id),false)
    await api('/api/settings/pc-agent',{enabled:true})
  })
  await check('dissolving a room revokes its pending approval and room-file bridge', async () => {
    const run = await start({path:file,deviceId:first.deviceId},'request'); await pending(run.id)
    await api('/api/rooms/' + roomId,undefined,'DELETE')
    assert.equal((await request('/api/agent/runs')).status,404)
    assert.equal((await api('/api/state',undefined,'GET',otherRoom.id)).approvals.some(a => a.runId === run.id),false)
  })
  console.log(count + ' PC room-file contract checks passed; ' + failures + ' failed. Harness transport and phone are fixtures; APK/provider checks run separately.')
  if (failures) process.exitCode = 1
} catch (error) { console.error(error.message); if (diagnostics) console.error(diagnostics.slice(-1500)); process.exitCode = 1 }
finally {
  for (const phone of phones) phone.socket.terminate()
  child.kill(); await until(()=>child.exitCode !== null || child.signalCode !== null).catch(()=>{})
}
