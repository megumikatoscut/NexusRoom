# NexusRoom 1.0.0 API reference / 接口参考

English reference below · [中文说明](#中文说明)

Unless another working directory is stated, run commands from the repository root. Source paths are relative to that root.

Application version is 1.0.0, Android versionCode 15. External Agent API and invitations use v1; multi-room device WSS uses v2. `GET /health` returns `version: "1.0.0"`. Production endpoint implementations in Host/Android source remain authoritative for complete parameter schemas.

## Authentication and errors

| Surface | Authentication and scope |
| --- | --- |
| Local `/api/*` | Loopback control-centre cookie; room through `X-Nexus-Room` or room query; mutating POST/PUT/PATCH/DELETE require `X-Nexus-Request: 1` |
| Device `/device/*` | Member Bearer token over certificate-pinned HTTPS/WSS; room and caller identity derived from token |
| External `/agent/v1/*` | Separately issued Agent API Bearer capability, relevant grants and confirmation policy |
| Harness room bridge | Current-user named pipe bound to active PC task/process/room; no external API token |

Discovery identifies candidate addresses; it does not authenticate a replacement Host. Do not disable TLS certificate validation. Error objects use `{title,status}`. Common statuses: 400 invalid input; 401 invalid credentials; 403 denied; 404 missing; 409 offline/busy/state conflict; 413 too large; 422 Android/model failure; 504 device timeout. Side-effecting calls are not automatically replayed after timeout.

## Calls and meetings

The following paths are relative to local `/api/communication` or authenticated `/device/communication`. Caller identity is fixed server-side. Client-supplied identity/mode replacement fields are rejected.

| Method | Path | Body and behavior |
| --- | --- | --- |
| GET | `/state` | Visible sessions, own invitations, devices and active session |
| POST | `/calls` | `{targetId}`; pending audio call |
| POST | `/calls/{id}/decision` | Recipient `{accept}` |
| POST | `/meetings` | `{title,visibility,inviteeIds?}`; title 1–80; visibility public/private |
| POST | `/meetings/{id}/join` | `{}`; public access or accepted private invitation |
| POST | `/meetings/{id}/invite` | Host `{deviceIds:[...]}` |
| POST | `/meetings/{id}/remove` | Host `{deviceId}` |
| POST | `/invitations/{id}/decision` | Recipient `{accept}` |
| POST | `/sessions/{id}/leave` | `{}`; host departure ends meeting; call departure ends call |
| POST | `/sessions/{id}/end` | `{}`; call participant or meeting host |
| POST | `/sessions/{id}/chat` | Participant `{text}`, at most 2,000 UTF-16 code units |
| POST | `/sessions/{id}/media` | Required booleans `{microphone,camera,screen}`, optional boolean `screenAudio` defaults false; device sound requires screen |

Targets accept exact IDs or unique case-insensitive exact names/models in the same room. Ambiguity returns 409; self-physical-device and cross-room calls are rejected. Calls expire after 45 seconds, invitations after 120. Maximums: 32 invitation targets, eight participants per meeting and eight active meetings per room. A physical device has one ringing/active communication session across rooms.

State fields are `{selfId,roomId,activeSessionId,devices,sessions,invitations}`. Device entries include identity/name/model/system/online/communicationOnline/busy. Sessions include IDs, kind (`call`/`meeting`), title, visibility, status (`ringing`/`active`/`ended`), caller/callee/host, times, participants and messages. Participant media flags are independent and reset false at end. Invitations are visible only to their recipient. Public nonparticipants see metadata with no chat; private unauthorized callers cannot inspect the session. Removed public participants and private leavers need new invitations. Host disconnect ends a meeting; another member disconnect removes that member. Chat is limited to 200 messages and cleared at end. Ended metadata is bounded to 200 server records and 40 relevant visible sessions and is not persisted.

### Signalling and media formats

Local clients connect to `/api/communication/ws?roomId=...` with the session cookie; Android uses `/device/communication/ws` with its member token. State events are `{type:"state",state}`. A send event is:

```json
{"type":"signal","sessionId":"session-id","targetId":"peer-id","signal":{"type":"offer","sdp":"v=0..."}}
```

The Host replaces source identity and forwards `{type:"signal",sessionId,fromId,signal}` only between admitted participants in the same active session. Signal type is offer/answer/ice. ICE candidate fields are limited to `candidate,sdpMid,sdpMLineIndex,usernameFragment`; candidate can be null. Valid media indices are 0–4. SDP is limited to 128 KiB, candidate text to 4,096 characters, signalling to 600 messages per ten seconds per connection. Malformed signals do not grant admission.

Unified Plan RTP slots are MID 0 microphone, MID 1 camera, MID 2 screen, MID 3 Windows device sound; the DataChannel occupies the application slot. Private calls require camera/screen/shared-sound sending inactive. Initial media flags are false. Manual call/accept may request microphone access; REST state never substitutes for system consent.

Windows shared sound uses RTP MID 3. Android uses encrypted DataChannel `nr-screen-audio`, `ordered=false,maxRetransmits=0`: an eight-byte big-endian header (`0x4e524131`, sampleRate 48000) followed by 1,920 bytes of mono PCM16LE, approximately 20 ms. Send/play queues are bounded and late data is discarded. See [meetings](MEETINGS.md) for Android AEC/routing limitations.

### Local Windows device sound

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/api/communication/screen-audio/capability` | `{supported,reason,sampleRate:48000,channels:1,encoding:"pcm16le"}` |
| WS | `/api/communication/sessions/{id}/screen-audio/ws?roomId=...` | Local admitted PC participant currently sharing screen; ready JSON then raw PCM16LE frames without NRA1 header |

Windows build 20348+ process-loopback excludes the Host and its WebView/Chromium process tree. The Host resolves the TCP client's PID and requires membership in that tree. An ordinary browser on localhost cannot use this channel. A selected shared window does not limit audio to that window; other capturable applications may be included. The socket is receive-only, has at most eight queued frames, roughly 20 ms messages and a two-second send deadline. Startup, capture and sends recheck membership/session/screen state. Stop screen, disconnect, leave, end or revoke stops capture. Closing the UI sound switch closes the socket; a media flag alone is not its cancellation mechanism.

### Communication tools

Both Agent implementations register `arrange_communication({action,targetId?,title?,visibility?,inviteeIds?})`. A call requires `targetId` and rejects meeting arguments; a meeting uses invitations and rejects `targetId`. Visibility defaults private. Strict schemas reject caller/room/mode overrides. Request mode approves the concrete send/create action; automatic mode sends it, while recipients retain admission and media consent.

Android calls `POST /device/agent/communication` with `{taskId,...arguments}`; device discovery uses `GET /device/agent/communication/devices?taskId=...`. The Host validates the active task and source. PC uses its task-bound named pipe. Completing a task does not end an already created call/meeting; cancelling a pending approval prevents sending.

## Rooms, discovery and files

`DELETE /api/rooms/{id}` requires local authentication and the mutation header. It ends that room's communications/tasks, revokes members and returns `{ok:true,fileArchive}`. The archive path is relative to user state: `removed-rooms/<roomId>-<guid>`, or empty when no files exist. Library blob copies move to the archive; metadata uses CurrentUser DPAPI. Successful removal frees active-library quota but archived copies still occupy disk. Persistence failure restores room/file records and rolls back copies where possible; residual archives remain for recovery. Original PC sources and Android downloads are retained. Uploads recheck room validity while streaming and before commit.

`GET /device/discovery` and UDP discovery expose public Host fingerprint, roomId, port and open status. `open=false` blocks new joins but permits existing-member address recovery. A saved member must validate a candidate using its existing pinned certificate/token and verify the returned roomId before saving the address. `POST /device/join` establishes membership; `/device/ws` carries hello, heartbeat, permissions, media and correlated RPC IDs/results. Revocation invalidates device credentials.

File exchange uses streaming and SHA-256 receipts, with 512 MiB per file and 10 GiB shared active-library quota. Device upload is `/device/files`; download `/device/files/{id}` is restricted to its matching pending recipient. Agent upload includes its task ID and is revalidated during streaming/commit. Android local Agent `GET /device/agent/files?taskId=...` lists deliverable library entries; `POST /device/agent/files/{fileId}/deliver` validates task/room/device/lease and dispatches WSS `receive_file`.

## Android-to-Windows remote control

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/device/pc/status` | Room permissions, PC occupancy and own session |
| POST | `/device/pc/start` | `{maxSize,fps,quality,audio}`; pending sessionId |
| WSS | `/device/pc/ws?sessionId=...` | Own locally approved session; media, input and ping |
| POST | `/device/pc/stop` | `{sessionId}`; own stop |
| GET | `/api/pc/remote/status` | Current local room session state |
| POST | `/api/pc/remote/permissions` | `{screen,control,audio,clipboard}`, default false |
| POST | `/api/pc/remote/decision` | Local `{sessionId,allow}` |
| POST | `/api/pc/remote/stop` | Stop current-room session |

Every session requires local PC confirmation and screen grant. Input additionally requires control; sound and clipboard have independent grants. Starting cannot preempt another PC task/session. Limits are maxSize 640–2560, fps 5–30 and quality 30–95. Input is `{type:"input",id,tool,arguments}` with `{type:"result",id,result,error}` response, at most 512 KiB UTF-8 per complete input message. Tools include normalized pointer/click, scroll (`120` per wheel notch), text (8,192 UTF-16 units), controlled keys and clipboard (65,536 units). Periodic `{type:"ping"}` maintains the session; stop/disconnect invalidates its ID.

Optional `seq` fixes sequence mode on the first message. It is an integer 1–9007199254740991, strictly increasing; failures consume the sequence. Do not mix sequenced/unsequenced modes or replay input. Unsequenced mode uses bounded ID deduplication. Key `count` is 1–64 for a single Backspace/Delete/arrow key; combinations run once, with permission rechecks. Native phone IME text/key operations do not require clipboard access.

PC frames have a 24-byte header: ASCII NRP3; big-endian int32 type (1 JPEG, 2 PCM16LE); big-endian int64 monotonic microseconds; two big-endian int32 fields (image width/height or audio sampleRate/channels). Payload follows byte 24. Audio is 48000/1. JPEG frames can expire; PCM uses bounded queues. This is distinct from Android H.264 transport.

## PC workspace browsing

`GET /api/agent/workspace?path=...&query=...` uses the local room. Device `/device/agent/workspace` additionally requires an online Agent-authorized member and enabled room PC Agent. Response is `{path,parentPath,defaultPath,roots,directories,files,truncated}`; files contain byte size and UTC ISO modifiedAt, nullable when unavailable. Omitted path selects Windows home. Folders/files are each capped at 1,000 after case-insensitive name filtering. Query is at most 100 trimmed characters without control characters. Bad/missing path returns 400, denial 403, temporary disk failure 409. Task startup revalidates the directory; cwd is not an OS sandbox.

## Agent runs and modes

Local `POST /api/agent/runs` accepts `{targetId,task,mode,profileId,workspacePath?}` (Android target also accepts deviceId). Device `POST /device/agent/runs` accepts `{task,mode,targetDeviceId?,profileId,workspacePath?}`, default target being the initiating phone. A PC target is `pc:<roomId>`; another Android target must be an authorized online same-room member with no conflicting lease. `workspacePath` is an existing Windows folder for PC tasks and defaults to Windows home.

GET returns room-scoped runs; device queries can select `?targetDeviceId=...`. DELETE `/api/agent/runs/{id}` or `/device/agent/runs/{id}` stops the corresponding room task. Device room/profile routes are `/device/room`, `/device/room/devices`, and `POST /device/room/profiles`. Android execution uses `agent_start` with a snapshotted profile, immediate accepted response and asynchronous accepted/progress/tool_started/tool_finished/permission_required/completed/failed/cancelled events. PC tasks use `PcAgentRunner` rather than Android `agent_start`.

Only `request` and `automatic` are valid modes; omitted mode defaults request. Mode is fixed at creation and appears in task output/audit. Android request mode approves risk tools individually, independently of the external API's confirmation setting. Automatic skips those application approvals but retains grants, leases, validation and cancellation. PC modes map to Harness `workspace-write`/`ask` and `danger-full-access`; see [PC Agent](PC_AGENT.md). Same-room approvals use local `/api/approvals/{id}` or device `/device/agent/approve`.

New rooms enable PC Agent. `POST /api/settings/pc-agent` with `{enabled}` changes that room and cancels its PC runs when disabled. External API folder grants remain independent. Phone v2 control uses `control_acquire/control_release` and a lease on subsequent commands. Obsolete `/api/scrcpy/*`, `/adb` and `/mirror/input` routes are absent.

### Android local Agent tools

These definitions come from Android `AgentTools`, not from the external Host registry. All require room Agent authorization and the applicable lease. “Control” means room control grant plus accessibility; “file read” requires Android 11+ all-files access or Android 10 storage-read permission. Request mode approval is additional to system permission.

| Tool | Behavior / additional grant | Request approval |
| --- | --- | --- |
| `get_device_info` | Device, battery, network and storage summary | No |
| `list_room_devices` | Same-task room PC/phone IDs, online and busy state | No |
| `arrange_communication` | Call/meeting request under active task | Yes |
| `list_apps` | Filter launchable applications | No |
| `open_app_by_name` | Unique name/package launch; control | Yes |
| `open_settings_page` | Allowlisted settings; control | Yes |
| `open_url` | HTTP(S) browser launch; control | Yes |
| `screenshot` | JPEG visual input; control and screen | Yes |
| `clipboard_get` | Available system text; clipboard grant and OS rules | No |
| `clipboard_set` | Text write; clipboard grant | Yes |
| `get_page_info` | Visible window/control tree and input candidates; control | No |
| `click_element` | Recent snapshot text/description/resource/index; control | Yes |
| `set_input_text` | Replace non-password input; control | Yes |
| `append_text` | Insert text; control | Yes |
| `clear_text` | Clear non-password input; control | Yes |
| `press_key` | Limited navigation/edit keys; control | Yes |
| `back` | Previous screen; control | Yes |
| `home` | System home; control | Yes |
| `recent` | Recent tasks; control | Yes |
| `scroll` | Up/down; control | Yes |
| `tap` | Normalized coordinates; control | Yes |
| `swipe` | Normalized endpoints; control | Yes |
| `get_app_usage_time` | Foreground usage; OS usage access | No |
| `get_notifications` | Recent notifications; OS notification access | No |
| `list_phone_files` | Phone IDs by path/name/extension; files and file read | No |
| `find_photos` | Photo name search; files and complete photo access | No |
| `list_photos` | Recent photos; files and complete photo access | No |
| `decode_recent_qr` | Local latest-photo QR decode; files/photo access | No |
| `find_phone_files` | Phone file-name search; files/file read | No |
| `get_file_info` | Opaque phone file metadata; files/file read | No |
| `read_phone_file` | Bounded text bytes at offset; files/file read | No |
| `open_file` | Installed viewer; files/file read/control | Yes |
| `share_file` | Android chooser, user selects recipient; files/file read/control | Yes |
| `send_file_to_pc` | Phone upload to current-room library with receipt; files/file read | Yes |
| `list_files` | Host-library files pending for this phone; files | No |
| `send_file` | Deliver selected pending Host file to phone with hash check; files | Yes |
| `compose_email` | Composer; explicit send=true verifies visible fields and actual send/close; control | Yes |
| `send_qr_link_email` | Local photo HTTP(S) QR, optional open and explicit actual email send; files/photo/control | Yes |

Android local tools have no shell or arbitrary Windows path capability. Phone files use media APIs and opaque IDs. `send_file_to_pc` is the opposite direction to `send_file`. Screenshot uses Android 11+ accessibility capture or an already system-approved same-room shared frame; it cannot silently start MediaProjection. JPEG maximum is 1,024 pixels on its longest side and 512 KiB. A compatible image-input model is required. Protected/black frames and Android 10 capture limitations can cause failure.

Clipboard read retains Android background restrictions; the optional NexusRoom IME can supply the platform bridge. Clipboard text maximum is 65,536 characters. Host-library `list_files` query is at most 100 characters and returns at most 200 pending/failed entries for this room/phone. `send_file` saves verified bytes to Android `Download/NexusRoom`; completed deliveries are no longer pending. Email success requires visible verified fields, actual send activation and composer closure; compose-only is not sent. Sending must originate in an explicit user task.

### PC Harness room tools

`list_room_devices({})` returns `{roomId,selfId,devices}` with task-room identities, names/models/system/type, online/communicationOnline, file/Agent grants and busy state. `send_file_to_phone({path,deviceId?})` accepts a readable existing path, at most 32,768 characters and no control characters; relative paths resolve against task cwd. Optional device ID is at most 100 characters and must be same-room; omission requires one online phone. Strict arguments reject room/mode overrides.

The Host rechecks active task, PC permission, target grants, lease and quota. Request mode approves path/size/recipient before import. Success `{ok:true,verified:true,fileId,deviceId,name,size,sha256,savedTo,alreadyReceived}` requires an actual verified Android receipt. Unchanged same-task retries reuse identity; cancellation, permission changes and failed verification cannot yield successful completion.

## External Agent API v1

Generate its independent token in Windows Agent API settings. Loopback base is `http://127.0.0.1:17890/agent/v1`; LAN uses the Host's HTTPS address on port 17891 with fingerprint pinning.

| Method | Relative path | Behavior |
| --- | --- | --- |
| GET | `/devices` | Nonrevoked room devices, permissions and activity |
| GET | `/tools` | Compatible JSON tool definitions/schemas |
| GET | `/devices/{id}/screenshot` | Latest received shared JPEG; requires phone capture, screen and Agent grant |
| POST | `/devices/{id}/actions` | `{tool,arguments}` with matching grants |

Registered external names are `device_info,screenshot,ui_tree,tap,swipe,scroll,text,back,home,recents,launch_app,list_apps,list_files,send_file,recent_photos,export_photo,clipboard_set,clipboard_get,edit,pc_info,pc_list_files,pc_send_file,pc_screenshot,pc_click,pc_text,pc_key`. These are distinct from Android local-model and Harness registries.

Normalized coordinates are 0–1. Swipe duration is 100–3000 ms. Text replacement is at most 8,192 characters and excludes password fields. `launch_app` takes a full package name. `recent_photos` count is 1–20; `export_photo` uses a returned photoId. `edit` supports insert/selectAll/copy/cut/Backspace/Delete/Enter/arrows/Home/End; copy/cut require clipboard authorization.

External PC tools require enabled room PC Agent. `pc_info` returns granted folder IDs; `pc_list_files` takes a granted folder/directory handle and returns at most 200 entries; `pc_send_file` accepts only returned file IDs. Native Harness cwd rules do not replace these handle constraints. Pending mutation approval lasts up to three minutes; clients need a timeout above 180 seconds, and disconnect cancels waiting work. Approval binds exact parameters and permissions are rechecked before execution. External tokens cannot manage rooms, invoke local UI APIs or bypass confirmation.

## Voice endpoints

Capture/inference are local. Device requests carry event IDs and transcription, never raw audio. Local calls use the normal local cookie/mutation/room headers; device room/source identity comes from its token.

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/api/voice/status` | `{enabled,wakeEnabled,ready,phase,error,roomId,profileId,workspacePath,recordingId,recordingRoomId,lastWake}` |
| POST | `/api/voice/settings` | `{enabled,wakeEnabled,profileId,workspacePath}` bound to request room |
| POST | `/api/voice/manual/start` | `{}` to `{recordingId}`; local voice must be enabled |
| POST | `/api/voice/manual/stop` | `{recordingId}` to `{text,recordingId}`; draft only |
| POST | `/api/voice/manual/cancel` | `{recordingId}` to `{ok}` |
| POST | `/api/voice/wake` or `/device/voice/wake` | `{eventId,profileId,workspacePath}` to `{wakeId,capture,sourceId,expiresAt}` |
| POST | `/api/voice/submit` or `/device/voice/submit` | `{wakeId,eventId,text}` to `{taskId,wakeId,status,targetId,runId,run,error}` |
| POST | `/api/voice/cancel` or `/device/voice/cancel` | `{wakeId,eventId}` to `{ok}` |
| GET | `/api/voice/tasks` or `/device/voice/tasks` | Current-room voice task index |

`roomId` is the listening binding; `recordingRoomId` identifies current capture. `lastWake={eventId,roomId,detectedAt}` is a process-local accepted wake used once for local navigation; remote events do not write it. Transcription does not keep the recording indicator lit. Submitted execution is automatic and reuses normal Agent status and DELETE-stop endpoints. See [offline voice](VOICE_INTERACTION.md) for arbitration windows, persisted dispatch guards, text normalization and failure recovery.

## 中文说明

应用版本为 1.0.0，Android versionCode 为 15。外部 Agent 与邀请协议使用 v1，多房间设备 WSS 使用 v2；`GET /health` 返回 `version: "1.0.0"`。上方英文表格保留端点、字段、工具名及完整参数约束，以下按相同功能说明中文语义。完整字段模式以 Host/Android 生产代码为准。

### 身份认证与错误

本地 `/api/*` 使用回环控制中心 cookie，房间由 `X-Nexus-Room` 或 room 查询项选择；POST/PUT/PATCH/DELETE 变更还需要 `X-Nexus-Request: 1`。设备 `/device/*` 在固定证书 HTTPS/WSS 上使用成员 Bearer token，由服务器从 token 推导房间与调用者。外部 `/agent/v1/*` 使用独立签发的能力 token，并检查相关授权/确认策略。Harness 桥为绑定活动 PC 任务、进程和房间的当前用户命名管道。

发现只提供候选地址，不能替换 Host 身份验证；保留 TLS 证书校验。错误格式为 `{title,status}`：400 输入无效，401 凭据无效，403 拒绝，404 不存在，409 离线/占用/状态冲突，413 过大，422 Android 或模型失败，504 设备超时。有副作用的请求超时后不自动重放。

### 通话、会议与信令

接口前缀分别为本地 `/api/communication` 和设备 `/device/communication`。身份由服务器固定，拒绝客户端替换身份或模式。`/state` 返回可见会话、个人邀请、设备与活动会话；`/calls` 创建待接听语音呼叫，`/calls/{id}/decision` 由接收者接受/拒绝。`/meetings` 创建 1–80 字符标题的 public/private 会议，`/join` 按公开权限或已接受私密邀请入会；`/invite`、`/remove` 由主持人管理。`/invitations/{id}/decision` 只供接收者处理。

`/sessions/{id}/leave` 使成员离开，主持人离开结束会议，通话一方离开结束通话；`/end` 仅限通话参与者或会议主持人。`/chat` 文本最多 2,000 个 UTF-16 单元；`/media` 必须给出 microphone/camera/screen 布尔值，screenAudio 默认 false 且必须同时共享屏幕。

目标为同房间精确 ID 或唯一且不区分大小写的精确名称/型号；歧义返回 409，拒绝跨房间及同一物理设备自呼叫。呼叫 45 秒、邀请 120 秒到期；最多 32 个邀请目标、每会八人、每房八个活动会议，同一物理设备跨房间仅有一个振铃/活动通信会话。

状态包含 `selfId,roomId,activeSessionId,devices,sessions,invitations`；设备给出身份/名称/型号/系统/在线/通信在线/忙，会议给出类型、可见性、状态、各方身份、时间、参与者和消息。各媒体标记独立且结束时清零。邀请仅接收者可见；公开会议未入会者只见元数据不见聊天，未授权者不能查看私密会话。被移除的公开成员或主动离开的私密成员需新邀请。主持人断线结束会议，普通成员断线仅移除自己。聊天内存最多 200 条并在结束清空；结束元数据最多 200 条服务器记录、40 个相关可见会话，不持久化。

本地 WebSocket 为 `/api/communication/ws?roomId=...`（cookie），Android 为 `/device/communication/ws`（成员 token）。`state` 事件承载状态；`signal` 事件含 sessionId、targetId 及 offer/answer/ice。Host 替换来源身份，仅向同一活动会话已入会成员转发。ICE 仅允许 candidate/sdpMid/sdpMLineIndex/usernameFragment，candidate 可为 null，媒体索引为 0–4。SDP 上限 128 KiB，candidate 文本上限 4,096 字符，每连接十秒最多 600 条信令。

Unified Plan 固定 MID 0 麦克风、1 相机、2 屏幕、3 Windows 设备声音，DataChannel 使用 application 槽。私密通话不发送相机/屏幕/共享声音；初始媒体均关闭，REST 标记不能替代系统授权。Android `nr-screen-audio` 为加密、无序、不重传 DataChannel：8 字节大端头（魔数 `0x4e524131`、48000 Hz），后接 1,920 字节单声道 PCM16LE，约 20 ms。有界队列丢弃过期媒体。

### Windows 设备声音与通信工具

`/api/communication/screen-audio/capability` 返回可用性、原因与 48 kHz/单声道/PCM16LE 描述；会话 screen-audio WebSocket 仅允许正在共享屏幕且已入会的本地 PC，先发送 ready JSON，再发无 NRA1 头的 PCM。

Windows build 20348+ 进程回环排除 Host 与 WebView/Chromium 子进程树。Host 解析 TCP 客户端 PID 并验证进程关系，普通 localhost 浏览器不能使用。只选共享窗口也可能包含其他可捕获应用声音。通道只读，最多八帧排队，每帧约 20 ms，发送期限两秒；启动/捕获/发送均复核成员与屏幕状态。停屏、断线、离会、结束、撤权释放捕获，关闭 UI 声音开关会关闭 socket。

两端 Agent 注册 `arrange_communication`；call 必须指定 targetId 且拒绝会议参数，meeting 使用邀请且拒绝 targetId，默认 private。严格模式拒绝覆盖 caller/room/mode。request 模式审批具体发送/创建动作，automatic 直接发送；接收者仍控制入会和媒体授权。Android 的 `/device/agent/communication` 与设备列表接口验证活动 taskId，PC 使用任务绑定管道。任务完成不结束已建立会话，取消待审批则不发送。

### 房间、发现与文件

`DELETE /api/rooms/{id}` 需本地认证与变更头，终止该房间通信/任务、撤销成员，并返回 `{ok:true,fileArchive}`。库文件移至用户状态下 `removed-rooms/<roomId>-<guid>`，无文件返回空路径；元数据由 DPAPI CurrentUser 保护。活动限额被释放，但归档仍占磁盘；持久化失败时恢复记录并尽可能回滚文件，残留归档保留恢复用途。原 PC 源文件和 Android 下载不被删除。上传流与提交前复核房间仍有效。

`/device/discovery` 与 UDP 公布 Host 指纹、roomId、端口和开放状态。open=false 阻止新成员，但允许旧成员恢复地址；旧成员须以已固定证书/token 验证候选并核对 roomId。`/device/join` 建立成员，`/device/ws` 传输 hello、心跳、权限、媒体和关联 RPC，撤权使设备凭据失效。

文件流使用 SHA-256 回执，单文件 512 MiB，全部活动共享库 10 GiB。设备上传 `/device/files`，下载 `/device/files/{id}` 限定为匹配的待接收者。Agent 上传携带任务 ID 并于传输/提交时重验；`/device/agent/files?taskId=...` 列出可交付项，`/deliver` 复核任务/房间/设备/租约并发送 WSS receive_file。

### 手机控制 Windows

`/device/pc/status` 查看权限/占用，`/start` 提交 maxSize/fps/quality/audio 并返回待确认 sessionId，`/ws` 在本地批准后承载媒体、输入和 ping，`/stop` 停止自己的会话。本地 `/api/pc/remote/*` 提供 status、permissions、decision、stop；屏幕/控制/声音/剪贴板默认均 false。

每会话需 PC 本地确认及屏幕权限，输入还需 control，声音和剪贴板独立。不得抢占其他 PC 工作。maxSize 为 640–2560，fps 为 5–30，quality 为 30–95；输入/结果通过关联 ID 交互，完整输入消息最大 512 KiB UTF-8。指针坐标归一化，滚轮每格 120，文本最多 8,192 个 UTF-16 单元，剪贴板 65,536。ping 续活；停止/断线使会话 ID 失效。

可选 seq 在首条消息确定有序模式，范围 1–9007199254740991 且严格递增，失败也消耗序号；禁止混合模式或重放。无序号模式使用有界 ID 去重。单个 Backspace/Delete/方向键 count 为 1–64，组合键只执行一次并重验权限；原生手机 IME 不依赖剪贴板授权。

PC 帧头长 24 字节：ASCII NRP3、大端 int32 类型（1 JPEG、2 PCM16LE）、大端 int64 单调微秒、两个大端 int32（宽高或采样率/通道），之后为载荷。声音为 48000/1；JPEG 可过期，PCM 有界排队。此协议与 Android H.264 不同。

### PC 工作区与 Agent 任务

`/api/agent/workspace?path=...&query=...` 使用本地房间，设备同名接口还需在线且 Agent 已授权、PC Agent 已启用。返回 path/parentPath/defaultPath/roots/directories/files/truncated，文件含字节数及可空 UTC ISO modifiedAt；默认 Windows 用户主目录。名称先不区分大小写筛选，再将文件/目录各限 1,000；query 去首尾空白后最多 100 字符且无控制字符。路径无效 400、拒绝 403、暂时磁盘故障 409；启动任务复核路径，cwd 不是操作系统沙箱。

本地 `POST /api/agent/runs` 提供 targetId/task/mode/profileId/workspacePath，设备接口提供 task/mode/targetDeviceId/profileId/workspacePath，默认目标为发起手机。PC ID 为 `pc:<roomId>`，其他 Android 目标须同房间、在线、已授权且无租约冲突。GET 返回房间任务，DELETE 停止相应任务。设备房间与配置接口为 `/device/room`、`/device/room/devices` 和 `POST /device/room/profiles`。

Android agent_start 使用配置快照，立即返回 accepted，后续异步发送进度、工具、权限、完成、失败或取消事件；PC 使用 PcAgentRunner。模式仅 request/automatic，默认 request，创建后固定并在输出/审计中体现。Android request 独立审批风险工具，automatic 仍保留授权、租约、校验和取消。PC 对应 Harness workspace-write/ask 与 danger-full-access。审批经本地 `/api/approvals/{id}` 或同房间 `/device/agent/approve`。

新房间默认启用 PC Agent，`POST /api/settings/pc-agent` 禁用时取消该房间 PC 运行。外部 API 文件夹授权独立。设备 v2 使用 control_acquire/control_release 及后续租约；旧 scrcpy/adb/mirror-input 路由不存在。

### Android 本地工具

上方完整工具表列出了每个工具的额外授权与 request 审批要求。所有工具均需房间 Agent 授权及适用租约；“control”还需房间控制权限与无障碍，“file read”需 Android 11+ 所有文件权限或 Android 10 读存储权限，应用审批不能替代系统权限。

只读信息/枚举类包括设备、房间设备、应用、剪贴板读取、页面树、使用时长、通知、文件/照片查询、QR 解码、文件元数据/文本与 Host 待收文件。需要审批的动作包括通信调度、启动应用/设置/URL、截图、剪贴板写入、点击/输入/按键/导航/滑动、打开/分享/收发文件和邮件发送。工具不提供 shell 或任意 Windows 路径；手机文件使用媒体 API 和不透明 ID。

`send_file_to_pc` 上传到 Host，`send_file` 则把 Host 待收文件保存至手机并校验哈希。截图使用 Android 11+ 无障碍捕获或已获系统同意的同房间共享帧，不能静默启动 MediaProjection；JPEG 最长边 1,024 像素且不超过 512 KiB，需要支持图片输入的模型。受保护黑帧及 Android 10 限制可能使任务失败。

剪贴板仍受后台系统限制，可选 NexusRoom IME 提供平台桥，文本最多 65,536 字符。Host list_files 查询最多 100 字符、返回本房间/本手机最多 200 条待收或失败项；成功文件保存至 `Download/NexusRoom` 并移出待收列表。邮件必须来自明确用户任务，成功需可见字段核验、实际点击发送且编辑器关闭；只打开草稿不算已发送。

### Harness 房间工具与外部 API

`list_room_devices` 返回当前任务房间身份、在线/忙状态和文件/Agent 授权；`send_file_to_phone` 接受已存在可读路径（最多 32,768 字符，无控制字符），相对路径依据任务 cwd。deviceId 最多 100 字符且同房间，省略时必须仅有一部在线手机；禁止覆盖 room/mode。Host 重验任务、PC 权限、目标授权、租约和容量。request 审批具体路径/大小/接收者；成功 verified=true 需要 Android 实际保存文件的 SHA-256 回执。同任务未改内容重试复用身份，取消/撤权/校验失败不得报告完成。

外部 Agent API token 从 Windows 设置独立生成。回环基址为 `http://127.0.0.1:17890/agent/v1`，局域网用 17891 HTTPS 并固定指纹。`/devices` 列设备，`/tools` 列工具模式，`/devices/{id}/screenshot` 取已共享截图，`/actions` 以 tool/arguments 调用；工具注册表与 Android 本地/Harness 不同，完整名称见上方英文参考。

外部坐标范围 0–1，滑动 100–3000 ms，非密码字段替换最多 8,192 字符；launch_app 使用完整包名，recent_photos 数量 1–20，export_photo 使用返回 ID。edit 的复制/剪切另需剪贴板授权。外部 PC 工具须启用 PC Agent：pc_info 返回已授权文件夹 ID，pc_list_files 仅接受已授权目录句柄且最多 200 项，pc_send_file 只接受返回的文件 ID。原生 Harness cwd 规则不替代这些限制。

变更审批最多三分钟，客户端超时应大于 180 秒，断线取消等待任务；批准绑定精确参数且执行前复核权限。外部 token 不能管理房间、调用本地 UI API 或跳过确认。

### 语音接口

捕获/推理在本地，设备只提交事件 ID 与转写，不提交原始音频。本地使用正常 cookie/变更/房间头，设备来源和房间由 token 决定。上方端点表完整列出 status/settings/manual-start/stop/cancel 与 wake/submit/cancel/tasks 的字段。

status 的 roomId 是监听绑定，recordingRoomId 是当前捕获房间；lastWake 为进程内本地接受事件，仅用于一次本地导航，远程事件不写入。manual stop 返回草稿转写；转写阶段不持续显示录音点。唤醒提交以 automatic 模式复用 Agent 状态与 DELETE 停止接口。仲裁窗口、持久化分发、文本归一化和故障恢复见 [离线语音](VOICE_INTERACTION.md)。
