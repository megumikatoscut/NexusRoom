import { projectPath } from '../scripts/submission-paths.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import test from 'node:test';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const version=JSON.parse(readFileSync(projectPath(root,'release.json'),'utf8')).version;
const exe=projectPath(root,'artifacts',`NexusRoom-Windows-x64-${version}.exe`);
const hash=data=>createHash('sha256').update(data).digest();
const fd=openSync(exe,'r'); const tail=Buffer.alloc(56);
readSync(fd,tail,0,56,statSync(exe).size-56);
const stub=Buffer.alloc(Number(tail.readBigInt64LE(8)));readSync(fd,stub,0,stub.length,0);closeSync(fd);
const crc=data=>{let c=0xffffffff;for(const byte of data){c^=byte;for(let n=0;n<8;n++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};
function zip(files){const parts=[],central=[];let offset=0;for(const [name,data] of files){const path=Buffer.from(name),packed=deflateRawSync(data);const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(8,8);header.writeUInt32LE(crc(data),14);header.writeUInt32LE(packed.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(path.length,26);const index=Buffer.alloc(46);index.writeUInt32LE(0x02014b50);index.writeUInt16LE(20,4);header.copy(index,6,4,28);index.writeUInt32LE(offset,42);central.push(index,path);parts.push(header,path,packed);offset+=header.length+path.length+packed.length;}const table=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(table.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...parts,table,end]);}
function bundle(files){const archive=zip(files),footer=Buffer.alloc(56);footer.write('NRSEXE01');footer.writeBigInt64LE(BigInt(stub.length),8);footer.writeBigInt64LE(BigInt(archive.length),16);hash(archive).copy(footer,24);return Buffer.concat([stub,archive,footer]);}
const folder=projectPath(root,'.local','sfx-format-'+process.pid);mkdirSync(folder,{recursive:true});
const fixture=join(folder,'fixture.exe');
function launch(args=['--extract-only']){return execFileSync(fixture,args,{windowsHide:true,encoding:'utf8',timeout:30000,env:{...process.env,NEXUS_PACKAGE_CACHE:join(folder,'cache')}}).trim();}
function run(bytes){writeFileSync(fixture,bytes);return launch();}
function replacePreservingWriteTime(file,bytes){
 const script=`$p='${file.replaceAll("'","''")}';$t=[IO.File]::GetLastWriteTimeUtc($p);[IO.File]::WriteAllBytes($p,[Convert]::FromBase64String('${bytes.toString('base64')}'));[IO.File]::SetLastWriteTimeUtc($p,$t)`;
 execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true});
}
const item=(path,data=Buffer.from('fixture'))=>[path,data];
const inventory=files=>item('.nexus-payload.tsv',Buffer.from(version+'\n'+files.map(([path,data])=>hash(data).toString('hex')+'\t'+data.length+'\t'+path).join('\n')+(files.length?'\n':'')));
test('single EXE validates extraction before publishing cache',()=>{
 try {
  const files=[item('nested/合法文件.txt')];const path=run(bundle([...files,inventory(files)]));assert.equal(readFileSync(join(path,files[0][0]),'utf8'),'fixture');
  for(const bad of ['../escaped.txt','C:/escaped.txt','nested/../escaped.txt','nested/alias.','nested/alias ','.nexus-complete','.NEXUS-COMPLETE','.nexus-complete.tmp']){const entries=[item(bad)];assert.throws(()=>run(bundle([...entries,inventory(entries)])),undefined,bad);}
  const duplicate=[item('same.txt'),item('SAME.txt')];assert.throws(()=>run(bundle([...duplicate,inventory(duplicate)])));
  assert.throws(()=>run(bundle([item('unlisted.txt'),inventory([])])));
  const wrong=[item('wrong.txt')];assert.throws(()=>run(bundle([...wrong,item('.nexus-payload.tsv',Buffer.from(version+'\n'+'0'.repeat(64)+'\t7\twrong.txt\n'))])));
  assert.throws(()=>run(Buffer.concat([stub,Buffer.from('truncated')])));
 } finally {rmSync(folder,{recursive:true,force:true});}
});
test('cached startup reuses verification and detects changed files and executable',()=>{
 mkdirSync(folder,{recursive:true});
 try {
  const files=[item('nested/runtime.txt')],bytes=bundle([...files,inventory(files)]);
  const cache=run(bytes),runtime=join(cache,files[0][0]),marker=join(cache,'.nexus-complete');
  const receipt=readFileSync(marker);
  assert.equal(launch(),cache);assert.deepEqual(readFileSync(marker),receipt,'unchanged cache should reuse its receipt');
  // Legacy and damaged receipts must fall back to content verification.
  writeFileSync(marker,hash(zip([...files,inventory(files)])).toString('hex'));
  assert.equal(launch(),cache);assert.notDeepEqual(readFileSync(marker),receipt);
  writeFileSync(marker,'damaged receipt');assert.equal(launch(),cache);
  replacePreservingWriteTime(runtime,Buffer.from('changed'));
  assert.throws(()=>launch(),undefined,'same-size corruption with restored LastWriteTime');
  writeFileSync(runtime,files[0][1]);assert.equal(launch(),cache);
  const replacement=runtime+'.replacement';writeFileSync(replacement,Buffer.from('changed'));rmSync(runtime);renameSync(replacement,runtime);
  assert.throws(()=>launch(),undefined,'replaced runtime file');
  writeFileSync(runtime,files[0][1]);assert.equal(launch(),cache);
  rmSync(runtime);assert.throws(()=>launch(),undefined,'missing runtime file');
  writeFileSync(runtime,files[0][1]);assert.equal(launch(),cache);
  const nested=join(cache,'nested'),linked=join(cache,'nested-original');renameSync(nested,linked);symlinkSync(linked,nested,'junction');
  try {assert.throws(()=>launch(),undefined,'linked directory with otherwise verified files');}
  finally {rmSync(nested);renameSync(linked,nested);}
  assert.equal(launch(),cache);
  // Edit an archive byte in place, preserving the source's write timestamp.
  const script=`$p='${fixture.replaceAll("'","''")}';$t=[IO.File]::GetLastWriteTimeUtc($p);$s=[IO.File]::Open($p,'Open','ReadWrite','None');try{$s.Position=${stub.length+35};$b=$s.ReadByte();$s.Position=${stub.length+35};$s.WriteByte([byte]($b -bxor 1))}finally{$s.Dispose()};[IO.File]::SetLastWriteTimeUtc($p,$t)`;
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true});
  assert.throws(()=>launch(),undefined,'changed executable with restored LastWriteTime');
  writeFileSync(fixture,bytes);assert.match(launch(['--verify-package']),/^PASS /);
 } finally {rmSync(folder,{recursive:true,force:true});}
});
