import {execFileSync} from 'node:child_process';

const launchFile = process.env.NEXUS_LIVE_LAUNCH_FILE;
const serial = process.env.NEXUS_LIVE_ADB_SERIAL;
const devicePort = Number(process.env.NEXUS_LIVE_DEVICE_PORT || 17891);
if (!launchFile || !serial || !Number.isInteger(devicePort) || devicePort < 1 || devicePort > 65535)
  throw new Error('Set NEXUS_LIVE_LAUNCH_FILE, NEXUS_LIVE_ADB_SERIAL and a valid NEXUS_LIVE_DEVICE_PORT');

const script = `Add-Type -AssemblyName System.Security
$bytes = [IO.File]::ReadAllBytes($env:NEXUS_LIVE_LAUNCH_FILE)
[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))`;
const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
  {encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']}).trim();
const launch = new URL(JSON.parse(raw));
if (launch.protocol !== 'http:' || launch.hostname !== '127.0.0.1' || !launch.hash.startsWith('#bootstrap='))
  throw new Error('Launch file does not contain a local NexusRoom URL');

const response = await fetch(launch.origin + '/api/invitation', {
  headers: {Authorization: `Bearer ${decodeURIComponent(launch.hash.slice(11))}`, 'X-Nexus-Request': '1'}
});
if (!response.ok) throw new Error(`Invitation request failed: HTTP ${response.status}`);
const invitation = await response.json();
const url = new URL('nexusroom://join');
url.searchParams.set('payload', JSON.stringify({...invitation, server: `https://127.0.0.1:${devicePort}`}));
const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], {windowsHide: true, stdio: 'ignore'});
execFileSync('adb', ['-s', serial, 'shell', 'am', 'start', '--activity-clear-top',
  '-a', 'android.intent.action.VIEW', '-d', url.toString(), '-n', 'com.nexusroom.android/.MainActivity'],
  {windowsHide: true, stdio: 'ignore'});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function uiNodes() {
  adb('shell', 'uiautomator', 'dump', '/sdcard/nexus-audit-window.xml');
  const xml = execFileSync('adb', ['-s', serial, 'exec-out', 'cat', '/sdcard/nexus-audit-window.xml'],
    {encoding: 'utf8', windowsHide: true});
  const unescape = value => value.replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&#10;', '\n');
  return [...xml.matchAll(/<node\b([^>]*?)(?:\/>|>)/g)].map(match => {
    const attributes = {};
    for (const item of match[1].matchAll(/([a-zA-Z]+)="([^"]*)"/g)) attributes[item[1]] = unescape(item[2]);
    return {kind: attributes.class, text: attributes.text, bounds: attributes.bounds};
  });
}
function tap(node) {
  const bounds = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(node.bounds);
  if (!bounds) throw new Error('Invalid Android UI bounds');
  adb('shell', 'input', 'tap', String(Math.floor((+bounds[1] + +bounds[3]) / 2)),
    String(Math.floor((+bounds[2] + +bounds[4]) / 2)));
}

await wait(700);
const server = `https://127.0.0.1:${devicePort}`;
for (const [index, value] of [server, invitation.roomId, invitation.password, invitation.fingerprint].entries()) {
  const fields = (await uiNodes()).filter(node => node.kind === 'android.widget.EditText');
  if (fields.length !== 5) throw new Error(`Expected five invitation fields; found ${fields.length}`);
  tap(fields[index]);
  adb('shell', 'input', 'keyevent', 'KEYCODE_CTRL_LEFT');
  adb('shell', 'input', 'keyevent', 'KEYCODE_A');
  adb('shell', 'input', 'keyevent', 'KEYCODE_DEL');
  adb('shell', 'input', 'text', value);
  adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  await wait(300);
}
let nodes = await uiNodes();
const join = nodes.find(node => node.kind === 'android.widget.Button' && node.text === '加入房间');
if (!join) throw new Error('Join button is not visible');
tap(join);
await wait(500);
nodes = await uiNodes();
const confirm = nodes.find(node => node.kind === 'android.widget.Button' && node.text === '一致，加入');
if (!confirm) throw new Error('Certificate fingerprint confirmation did not appear');
tap(confirm);
await wait(3000);
const state = await fetch(launch.origin + '/api/state', {
  headers: {Authorization: `Bearer ${decodeURIComponent(launch.hash.slice(11))}`, 'X-Nexus-Request': '1'}
}).then(result => result.json());
if (!state.devices?.some(device => device.online)) throw new Error('Phone did not become online in the audit room');
console.log(JSON.stringify({roomId: invitation.roomId, fingerprintPrefix: invitation.fingerprint.slice(0, 12), online: true}));
