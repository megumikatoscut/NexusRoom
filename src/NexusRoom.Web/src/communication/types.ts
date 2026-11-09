export interface CommunicationDevice {
  id: string; name: string; model: string; system: string;
  online: boolean; communicationOnline: boolean; busy: boolean;
}
export interface Participant {
  deviceId: string; name: string; system: string; joinedAt: string;
  microphone: boolean; camera: boolean; screen: boolean; screenAudio?: boolean;
}
export interface ChatMessage { id: string; senderId: string; senderName: string; text: string; sentAt: string }
export interface CommunicationSession {
  id: string; roomId: string; kind: 'call' | 'meeting'; title: string;
  visibility: 'public' | 'private'; status: 'ringing' | 'active' | 'ended';
  hostId: string; callerId: string; calleeId: string; createdAt: string;
  expiresAt: string | null; endedAt: string | null; endReason: string;
  participants: Participant[]; messages: ChatMessage[];
}
export interface MeetingInvitation {
  id: string; sessionId: string; hostId: string; hostName: string; title: string;
  visibility: 'public' | 'private'; createdAt: string; expiresAt: string;
}
export interface CommunicationState {
  selfId: string; roomId: string; activeSessionId: string;
  devices: CommunicationDevice[]; sessions: CommunicationSession[]; invitations: MeetingInvitation[];
}
export type RtcSignal = { type: 'offer' | 'answer'; sdp: string } | { type: 'ice'; candidate: RTCIceCandidateInit };
export type MediaKey = 'microphone' | 'camera' | 'screen';
export interface MediaFlags { microphone: boolean; camera: boolean; screen: boolean; screenAudio: boolean }
export interface PeerMedia { id: string; audio: MediaStream; camera: MediaStream; screen: MediaStream; screenAudio: MediaStream; connection: RTCPeerConnectionState }
