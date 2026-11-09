export type Page = 'overview' | 'devices' | 'files' | 'communication' | 'agent' | 'logs' | 'settings';
export interface Permissions { screen: boolean; control: boolean; files: boolean; clipboard: boolean; agent: boolean; audio: boolean; screenAllowed: boolean }
export interface Device { id: string; name: string; system: string; version: string; ip: string; battery: number; charging: boolean; width: number; height: number; lastSeen: string; permissions: Permissions; roomId: string; physicalId: string; activity: 'online' | 'offline' | 'working' | 'busy'; ownerRoom: string; online: boolean; capture?: { state: string; stage: string; error: string; encoder: string; width: number; height: number }; media?: {videoPackets: number; keyframes: number; lastVideoAt: string | null} }
export interface Transfer { id: string; name: string; deviceId: string; direction: string; size: number; sha256: string; status: string; error?: string; createdAt: string }
export interface Approval { id: string; deviceId: string; tool: string; arguments: Record<string, unknown>; runId: string; expiresAt: string }
export interface PcRemotePermissions { screen: boolean; control: boolean; audio: boolean; clipboard: boolean }
export interface PcRemoteSession { sessionId: string; state: string; deviceId: string; deviceName: string; roomId: string; roomName: string; error?: string }
export interface PcRemoteStatus { permissions: PcRemotePermissions; activity: Device['activity']; session: PcRemoteSession | null }
export interface RoomState { room: { id: string; name: string; open: boolean }; rooms: { id: string; name: string; open: boolean }[]; host: { name: string; system: string; version: string; online: boolean; activity: Device['activity']; ownerRoom: string; remote: PcRemoteStatus | null; addresses: string[]; fingerprint: string }; devices: Device[]; transfers: Transfer[]; approvals: Approval[]; media: { available: boolean; active: string[]; pending?: string[] } }
export interface Invitation { version: number; server: string; roomId: string; password: string; fingerprint: string; name: string }
export interface Audit { id: string; time: string; category: string; action: string; deviceId: string; result: string }
export type AgentMode = 'request' | 'automatic';
export interface AgentTarget { id: string; kind: 'pc' | 'android'; name: string; online: boolean; agent: boolean; activity: Device['activity']; device?: Device }
export interface AgentProfile { id: string; name: string; apiType: 'chat_completions' | 'responses'; apiUrl: string; model: string; maxCalls: number; maxSteps: number; timeoutSeconds: number; hasKey: boolean }
export interface Run { mode: AgentMode; id: string; deviceId: string; roomId?: string; profileId?: string; profileName?: string; task: string; status: string; result?: string; startedAt: string; events: { time: string; kind: string; text: string }[] }
export interface Settings { apiUrl: string; model: string; hasKey: boolean; confirmMutations: boolean; pcAgentEnabled: boolean; pcRemotePermissions: PcRemotePermissions; sharedFolders: {id: string; name: string; path: string}[]; hasExternalToken: boolean; dataDirectory: string; defaultProfileId: string; profiles: AgentProfile[] }

export const activityLabel = (d: Device) => !d.online ? "离线" : ({ online: "在线", working: "工作", busy: "忙碌", offline: "离线" }[d.activity]);
export const hostActivityLabel = (host: RoomState['host']) => !host.online ? '离线' : ({ online: '在线', working: '工作', busy: '忙碌', offline: '离线' }[host.activity] ?? '在线');
