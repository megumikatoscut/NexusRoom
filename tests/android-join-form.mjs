import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

// Run against a debug or locally signed release APK already installed on ADB.
// This exercises the same invitation parser and Activity resume path as QR scan.
const serial = process.env.NEXUS_QA_SERIAL;
if (!serial) throw new Error('Set NEXUS_QA_SERIAL to the ADB device serial');
const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], {encoding: 'utf8', windowsHide: true});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function invitation(roomId) {
  return {
    version: 1,
    server: 'https://192.168.42.7:17891',
    roomId,
    password: 'qr-test-password',
    fingerprint: 'a'.repeat(64),
    name: 'QR test'
  };
}

function openInvite(value) {
  const url = new URL('nexusroom://join');
  url.searchParams.set('payload', JSON.stringify(value));
  adb('shell', 'am', 'start', '--activity-clear-top', '--activity-single-top',
    '-a', 'android.intent.action.VIEW', '-d', url.toString(),
    '-n', 'com.nexusroom.android/.MainActivity');
}

async function visibleFields() {
  await wait(500);
  adb('shell', 'uiautomator', 'dump', '/sdcard/nexusroom-join-test.xml');
  const xml = adb('exec-out', 'cat', '/sdcard/nexusroom-join-test.xml');
  const size = xml.match(/\bbounds="\[0,0\]\[(\d+),(\d+)\]"/);
  if (!size) throw new Error('Unable to read Android screen bounds');
  const values = [...xml.matchAll(/<node\b[^>]*class="android\.widget\.EditText"[^>]*>/g)].map(([tag]) => {
    const raw = tag.match(/\btext="([^"]*)"/)?.[1] ?? '';
    return raw.replaceAll('&quot;', '"').replaceAll('&amp;', '&');
  });
  return {values, width: Number(size[1]), height: Number(size[2])};
}

async function fields() {
  const size = await visibleFields();
  const x = Math.round(size.width / 2);
  for (let index = 0; index < 3; index++) adb('shell', 'input', 'swipe',
    String(x), String(Math.round(size.height * .2)),
    String(x), String(Math.round(size.height * .8)), '200');
  const seen = new Set();
  for (let index = 0; index < 4; index++) {
    const screen = await visibleFields();
    screen.values.forEach(value => seen.add(value));
    adb('shell', 'input', 'swipe', String(x), String(Math.round(screen.height * .8)),
      String(x), String(Math.round(screen.height * .2)), '350');
  }
  return [...seen];
}

async function assertInvite(value) {
  const actual = await fields();
  assert.ok(actual.includes(value.server), 'server should be filled');
  assert.ok(actual.includes(value.roomId), 'room ID should be filled');
  assert.ok(actual.includes('•'.repeat(value.password.length)), 'password should be filled');
  assert.ok(actual.includes(value.fingerprint), 'fingerprint should be filled');
}

const first = invitation('123456');
openInvite(first);
await assertInvite(first);
adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
adb('shell', 'am', 'start', '--activity-clear-top', '--activity-single-top',
  '-n', 'com.nexusroom.android/.MainActivity');
await assertInvite(first);
const second = invitation('654321');
openInvite(second);
await assertInvite(second);
console.log('PASS invitation fills all fields, survives resume, and a second invite replaces it');
