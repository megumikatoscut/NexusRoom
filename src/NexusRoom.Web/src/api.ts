declare const __NEXUSROOM_VERSION__: string;

export const storageKey = (name: string) => `nexusroom:${__NEXUSROOM_VERSION__}:${name}`;
let currentRoom = localStorage.getItem(storageKey('room')) || '';
export const roomId = () => currentRoom;
export function setRoomId(id: string) { currentRoom = id; localStorage.setItem(storageKey('room'), id); }
export async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  return roomApi<T>(currentRoom, path, body, method);
}
export async function roomApi<T>(room: string, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(path, { method: method ?? (body === undefined ? 'GET' : 'POST'), credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Nexus-Request': '1', 'X-Nexus-Room': room }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.title ?? `请求失败 (${response.status})`); }
  return await response.json() as T;
}
export async function bootstrap() {
  const token = new URLSearchParams(location.hash.slice(1)).get('bootstrap');
  if (token) { await api('/api/session', { token }); history.replaceState(null, '', location.pathname); }
}
export function upload(file: File, deviceId: string, progress: (percent: number) => void, signal: AbortSignal, uploadRoom = currentRoom): Promise<void> {
  return new Promise((resolve, reject) => {
    if (file.size > 512 * 1024 * 1024) { reject(new Error('单个文件最大 512 MB')); return; }
    const xhr = new XMLHttpRequest(); xhr.open('POST', `/api/files?deviceId=${encodeURIComponent(deviceId)}`);
    xhr.setRequestHeader('X-Nexus-Request', '1'); xhr.setRequestHeader('X-Nexus-Room', uploadRoom); xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name)); xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = e => { if (e.lengthComputable) progress(Math.round(e.loaded / e.total * 100)); };
    xhr.onload = () => { if (xhr.status < 300) resolve(); else { try { reject(new Error(JSON.parse(xhr.responseText).title)); } catch { reject(new Error('上传失败')); } } };
    xhr.onerror = () => reject(new Error('文件上传中断')); xhr.onabort = () => reject(new Error('上传已取消'));
    if (signal.aborted) { reject(new Error('上传已取消')); return; }
    const abort = () => xhr.abort();
    signal.addEventListener('abort', abort, { once: true }); xhr.onloadend = () => signal.removeEventListener('abort', abort); xhr.send(file);
  });
}
export const command = (id: string, tool: string, args: Record<string, unknown> = {}) => api(`/api/devices/${id}/command`, { tool, arguments: args });
export const bytes = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
export const time = (date: string) => new Date(date).toLocaleTimeString('zh-CN', { hour12: false });
