import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

// Protocol-only regression tests for the phone-local Agent. The connected test device
// is a deterministic WebSocket peer; no provider or API key is contacted.
export async function agentModeChecks({check,host,mobile,until,device,session,fileId,pendingFileId,pendingRawFile}) {
  const tasks = new Map();
  const send = value => { if (session.ws.readyState === 1) session.ws.send(JSON.stringify(value)); };
  const event = (taskId, status, text, extra = {}) => send({type:'agent_event', taskId, status, event:status, text, step:extra.step ?? 0, ...extra});
  const commands = () => session.received.filter(message => !message.tool.startsWith('control_'));

  // Simulate the Android Agent contract. agent_start is acknowledged immediately;
  // execution is represented only by agent_event messages.
  session.agentHandler = message => {
    const args = message.arguments ?? {};
    if (message.tool === 'agent_start') {
      const taskId = args.taskId;
      const prompt = String(args.prompt ?? '');
      const state = {taskId, mode: args.mode ?? 'request', prompt, profile: args.profile ?? {}, approved: false, held: false};
      tasks.set(taskId, state);
      send({type:'result', id:message.id, result:{accepted:true, taskId}});
      setTimeout(() => {
        if (!tasks.has(taskId)) return;
        event(taskId, 'accepted', '手机已接收任务');
        if (prompt.includes('cancel fixture')) {
          state.held = true; event(taskId, 'progress', '等待下一步操作'); return;
        }
        if (prompt.includes('timeout fixture')) {
          state.held = true; event(taskId, 'progress', `已应用超时配置 ${state.profile.timeoutSeconds}s`); return;
        }
        if (state.mode === 'request' && prompt.includes('clipboard approval fixture')) {
          state.requestId = `approval-${taskId}`;
          event(taskId, 'permission_required', '等待批准：修改剪贴板', {
            tool:'clipboard_set', requestId:state.requestId, step:1,
            arguments:{target:'Android 系统剪贴板', textPreview:'private-clipboard-token', textLength:23, apiKey:'must-never-appear'}
          });
          return;
        }
        if (state.mode === 'request' && prompt.includes('approval fixture')) {
          state.requestId = `approval-${taskId}`;
          event(taskId, 'permission_required', '等待批准：点击控件', {
            tool:'click_element', requestId:state.requestId, step:1,
            arguments:{textPreview:'确认', textLength:2, resourceId:'com.example:id/confirm', index:3}
          });
          return;
        }
        event(taskId, 'tool_started', '读取设备信息', {tool:'get_device_info', step:1});
        event(taskId, 'tool_finished', '读取设备信息完成', {tool:'get_device_info', step:1});
        event(taskId, 'completed', '手机本地 Agent 已完成任务', {final:true, result:'手机本地 Agent 已完成任务', step:1});
      }, 0);
      return;
    }
    if (message.tool === 'agent_cancel') {
      const taskId = args.taskId, state = tasks.get(taskId);
      send({type:'result', id:message.id, result:{ok:true, taskId}});
      if (state) { state.held = false; event(taskId, 'cancelled', '任务已停止；已完成的手机操作不会撤销', {final:true}); }
      return;
    }
    if (message.tool === 'agent_approve') {
      const taskId = args.taskId, state = tasks.get(taskId);
      send({type:'result', id:message.id, result:{ok:true, taskId}});
      if (!state || state.requestId !== args.requestId) return;
      if (args.approved) {
        event(taskId, 'tool_started', '点击控件中', {tool:'click_element', step:1});
        event(taskId, 'tool_finished', '点击控件完成', {tool:'click_element', step:1});
        event(taskId, 'completed', '请求模式任务已完成', {final:true, result:'请求模式任务已完成', step:1});
      } else event(taskId, 'failed', '用户未批准 点击控件，需要人工介入', {final:true, step:1});
    }
  };

  async function runs() { return (await host('/api/agent/runs')).value; }
  async function finish(id, status = 'completed') {
    await until(async () => (await runs()).find(run => run.id === id)?.status === status, 8000);
    return (await runs()).find(run => run.id === id);
  }
  async function begin(mode, prompt, deviceId = device.deviceId, profileId = '') {
    const body = {deviceId, task:prompt, mode, profileId};
    const result = await host('/api/agent/runs', body);
    assert.equal(result.status, 200, JSON.stringify(result.value));
    return result.value;
  }
  async function setPermissions(value) {
    session.ws.send(JSON.stringify({type:'permissions', permissions:value}));
    await until(async () => {
      const found = (await host('/api/state')).value.devices.find(item => item.id === device.deviceId);
        return found?.permissions?.agent === !!value.agent && found?.permissions?.files === !!value.files;
    });
  }
  const permissions = {screen:true, control:true, files:true, agent:true, clipboard:false, audio:false, screenAllowed:false};
  await host('/api/settings', {apiUrl:'https://api.example.test/v1', apiKey:'local-test-only', model:'local-protocol-fixture', confirmMutations:true});

  try {
    await check('Android room profiles create, edit, select, delete, and synchronize by profile ID', async () => {
      const before = (await mobile('/device/room', undefined, device.token)).value;
      const defaultId = before.defaultProfileId;
      const created = await mobile('/device/room/profiles', {
        createNew:true, name:'Android profile fixture', apiType:'chat_completions', apiUrl:'https://api.openai.com/v1',
        model:'android-profile-fixture', apiKey:'android-profile-test-key', maxCalls:7, maxSteps:8, timeoutSeconds:60
      }, device.token);
      assert.equal(created.status, 200, JSON.stringify(created.value));
      assert.equal(created.value.hasKey, true); assert.equal(created.value.apiKey, undefined);
      let room = (await mobile('/device/room', undefined, device.token)).value;
      assert.ok(room.profiles.some(profile => profile.id === created.value.id));
      assert.equal(room.defaultProfileId, defaultId, 'creating another plan must preserve the room default');
      const edited = await mobile('/device/room/profiles', {
        profileId:created.value.id, name:'Android profile edited', apiType:'responses', apiUrl:'https://api.openai.com/v1',
        model:'android-profile-edited', apiKey:'', maxCalls:9, maxSteps:10, timeoutSeconds:90
      }, device.token);
      assert.equal(edited.status, 200, JSON.stringify(edited.value));
      assert.equal(edited.value.id, created.value.id); assert.equal(edited.value.name, 'Android profile edited');
      await mobile('/device/room/profiles', {
        profileId:created.value.id, name:'Android profile edited', apiType:'responses', apiUrl:'https://api.openai.com/v1',
        model:'android-profile-edited', apiKey:'', maxCalls:9, maxSteps:10, timeoutSeconds:90, setDefault:true
      }, device.token);
      room = (await mobile('/device/room', undefined, device.token)).value;
      assert.equal(room.defaultProfileId, created.value.id);
      const desktop = (await host('/api/settings')).value;
      assert.ok(desktop.profiles.some(profile => profile.id === created.value.id && profile.name === 'Android profile edited'));
      assert.equal(desktop.defaultProfileId, created.value.id);
      const selectedRun = await mobile('/device/agent/runs', {task:'selected profile fixture', mode:'automatic', profileId:created.value.id}, device.token);
      assert.equal(selectedRun.status, 200, JSON.stringify(selectedRun.value));
      await until(async () => session.received.some(message => message.tool === 'agent_start' && message.arguments?.taskId === selectedRun.value.id));
      const transported = session.received.find(message => message.tool === 'agent_start' && message.arguments?.taskId === selectedRun.value.id);
      assert.equal(transported.arguments.profile.model, 'android-profile-edited');
      assert.equal(transported.arguments.profile.apiType, 'responses');
      await until(async () => (await mobile('/device/agent/runs', undefined, device.token)).value.find(run => run.id === selectedRun.value.id)?.status === 'completed');
      const deleted = await mobile(`/device/room/profiles/${created.value.id}`, undefined, device.token, 'DELETE');
      assert.equal(deleted.status, 200, JSON.stringify(deleted.value));
      room = (await mobile('/device/room', undefined, device.token)).value;
      assert.notEqual(room.defaultProfileId, created.value.id); assert.ok(!room.profiles.some(profile => profile.id === created.value.id));
      if (room.profiles.length === 1) assert.equal((await mobile(`/device/room/profiles/${room.profiles[0].id}`, undefined, device.token, 'DELETE')).status, 409);
    });

    await check('local Agent request mode waits for permission_required and resumes after approval', async () => {
      const before = commands().length;
      const run = await begin('request', 'approval fixture');
      await until(async () => (await runs()).find(item => item.id === run.id)?.events.some(item => (item.Kind ?? item.kind) === 'permission_required'));
      assert.equal(commands().length, before + 1);
      const current = (await runs()).find(item => item.id === run.id);
      const eventForApproval = current.events.find(item => (item.Kind ?? item.kind) === 'permission_required');
      assert.ok(eventForApproval);
      assert.deepEqual(eventForApproval.arguments, {textPreview:'确认', textLength:2, resourceId:'com.example:id/confirm', index:3});
      const pending = (await host('/api/state')).value.approvals;
      assert.equal(pending.length, 1);
      assert.equal(pending[0].tool, 'click_element');
      assert.deepEqual(pending[0].arguments, {textPreview:'确认', textLength:2, resourceId:'com.example:id/confirm', index:3});
      await host(`/api/approvals/${pending[0].id}`, {allow:true});
      const completed = await finish(run.id);
      assert.equal(completed.status, 'completed');
      assert.ok(completed.events.some(item => (item.Kind ?? item.kind) === 'assistant'));
    });

    await check('local Agent automatic mode executes without permission_required', async () => {
      const run = await begin('automatic', 'automatic fixture');
      const completed = await finish(run.id);
      assert.equal(completed.status, 'completed');
      assert.ok(!completed.events.some(item => (item.Kind ?? item.kind) === 'permission_required'));
      const start = session.received.find(message => message.tool === 'agent_start' && message.arguments?.taskId === run.id);
      assert.equal(start.arguments.mode, 'automatic');
      assert.equal(start.arguments.profile.apiKey, 'local-test-only');
    });

    await check('approval summary shows target without recording clipboard content or secrets', async () => {
      const run = await begin('request', 'clipboard approval fixture');
      await until(async () => (await host('/api/state')).value.approvals.some(item => item.runId === run.id));
      const approval = (await host('/api/state')).value.approvals.find(item => item.runId === run.id);
      assert.equal(approval.tool, 'clipboard_set');
      assert.equal(approval.arguments.target, 'Android 系统剪贴板');
      assert.equal(approval.arguments.textLength, 23);
      assert.equal(approval.arguments.textPreview, '[剪贴板内容未记录]');
      assert.ok(!JSON.stringify(approval).includes('private-clipboard-token'));
      assert.ok(!JSON.stringify(approval).includes('must-never-appear'));
      await host(`/api/approvals/${approval.id}`, {allow:false});
      await finish(run.id, 'failed');
    });

    await check('phone Agent file bridge lists only pending files and verifies delivery', async () => {
      const run = await begin('automatic', 'cancel fixture file bridge');
      await until(async () => tasks.get(run.id)?.held === true);
      const path = `/device/agent/files?taskId=${run.id}`;
      const listing = await mobile(path, undefined, device.token);
      assert.equal(listing.status, 200, JSON.stringify(listing.value));
      assert.ok(Array.isArray(listing.value));
      assert.ok(listing.value.some(file => file.fileId === pendingFileId && file.name === 'agent-pending.txt'));
      assert.ok(!listing.value.some(file => file.fileId === fileId), 'completed transfer must not be offered again');
      assert.equal((await mobile(`/device/agent/files?taskId=${run.id}&query=no-match`, undefined, device.token)).value.length, 0);
      assert.equal((await mobile('/device/agent/files', undefined, device.token)).status, 400);
      assert.equal((await mobile('/device/agent/files?taskId=another-task', undefined, device.token)).status, 404);

      const delivered = await mobile(`/device/agent/files/${pendingFileId}/deliver`, {taskId:run.id}, device.token);
      assert.equal(delivered.status, 200, JSON.stringify(delivered.value));
      assert.equal(delivered.value.sha256, createHash('sha256').update(pendingRawFile).digest('hex'));
      assert.deepEqual(session.downloads.find(item => item.fileId === pendingFileId)?.bytes, pendingRawFile);
      assert.equal((await host('/api/state')).value.transfers.find(item => item.id === pendingFileId)?.status, 'completed');
      assert.equal((await mobile(`/device/agent/files/${pendingFileId}/deliver`, {taskId:run.id}, device.token)).status, 409);

      const uploadHeaders = {'X-File-Name':'agent-upload.txt', 'X-Agent-Task-Id':run.id};
      assert.equal((await mobile('/device/files', pendingRawFile, device.token, 'POST', {...uploadHeaders,'X-Agent-Task-Id':'another-task'})).status, 404);
      const uploaded = await mobile('/device/files', pendingRawFile, device.token, 'POST', uploadHeaders);
      assert.equal(uploaded.status, 200, JSON.stringify(uploaded.value));
      assert.equal(uploaded.value.sha256, createHash('sha256').update(pendingRawFile).digest('hex'));
      assert.equal((await host('/api/state')).value.transfers.find(item => item.id === uploaded.value.id)?.direction, 'toWindows');

      await setPermissions({...permissions, files:false});
      assert.equal((await mobile(path, undefined, device.token)).status, 403);
      assert.equal((await mobile('/device/files', pendingRawFile, device.token, 'POST', uploadHeaders)).status, 403);
      await setPermissions(permissions);
      await host(`/api/agent/runs/${run.id}`, undefined, undefined, 'DELETE');
      await finish(run.id, 'cancelled');
      assert.equal((await mobile(path, undefined, device.token)).status, 409);
      assert.equal((await mobile('/device/files', pendingRawFile, device.token, 'POST', uploadHeaders)).status, 409);
    });

    await check('local Agent request denial fails and leaves no pending approval', async () => {
      const run = await begin('request', 'approval fixture');
      await until(async () => (await host('/api/state')).value.approvals.length === 1);
      const approval = (await host('/api/state')).value.approvals[0];
      await host(`/api/approvals/${approval.id}`, {allow:false});
      const failed = await finish(run.id, 'failed');
      assert.ok(failed.events.some(item => (item.Kind ?? item.kind) === 'error'));
      assert.equal((await host('/api/state')).value.approvals.length, 0);
    });

    await check('cancelling a local Agent task sends agent_cancel and terminal cancelled event', async () => {
      const run = await begin('automatic', 'cancel fixture');
      await until(async () => tasks.get(run.id)?.held === true);
      assert.equal((await host(`/api/agent/runs/${run.id}`, undefined, undefined, 'DELETE')).status, 200);
      const cancelled = await finish(run.id, 'cancelled');
      assert.ok(cancelled.events.some(item => (item.Kind ?? item.kind) === 'status'));
      assert.ok(session.received.some(message => message.tool === 'agent_cancel' && message.arguments?.taskId === run.id));
    });

    await check('profile limits and timeout are transported to the phone-local Agent', async () => {
      const profile = await host('/api/settings/profiles', {name:'Protocol fixture', apiType:'chat_completions', apiUrl:'https://api.example.test/v1', model:'fixture', apiKey:'local-test-only', maxCalls:3, maxSteps:2, timeoutSeconds:30});
      assert.equal(profile.status, 200, JSON.stringify(profile.value));
      const run = await begin('automatic', 'timeout fixture', device.deviceId, profile.value.id);
      await until(async () => tasks.get(run.id)?.held === true);
      const start = session.received.find(message => message.tool === 'agent_start' && message.arguments?.taskId === run.id);
      assert.equal(start.arguments.profile.maxCalls, 3);
      assert.equal(start.arguments.profile.maxSteps, 2);
      assert.equal(start.arguments.profile.timeoutSeconds, 30);
      await host(`/api/agent/runs/${run.id}`, undefined, undefined, 'DELETE');
      await finish(run.id, 'cancelled');
    });

    await check('Android Agent permission is still required before local execution', async () => {
      await setPermissions({...permissions, agent:false});
      assert.equal((await host('/api/agent/runs', {deviceId:device.deviceId, task:'no consent', mode:'automatic'})).status, 403);
      await setPermissions(permissions);
    });
  } finally {
    session.agentHandler = null;
    await host('/api/settings', {apiUrl:'https://api.example.test/v1', apiKey:'local-test-only', model:'local-protocol-fixture', confirmMutations:true});
  }
}
