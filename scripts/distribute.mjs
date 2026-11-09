import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { projectPath, submissionRoot } from './submission-paths.mjs';
import { resolveHarnessSource } from './resolve-harness-source.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const release=JSON.parse(readFileSync(join(root,'release.json'),'utf8'));
const digest=async path=>{const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');};
const files=[];
const generated=name=>name.split('/').some(part=>['.git','.local','node_modules','.gradle','__pycache__'].includes(part)) ||
  /^(?:artifacts|test-results|playwright-report|coverage|\.vs|\.idea)(?:\/|$)/.test(name) ||
  /^(?:src|tests)\/.*\/(?:bin|obj)(?:\/|$)/.test(name) ||
  /^(?:src\/NexusRoom.Host\/wwwroot|src\/NexusRoom.Web\/dist|android\/(?:app\/)?build)(?:\/|$)/.test(name) ||
  /\.(?:pyc|tsbuildinfo|log|dmp|idsig)$/.test(name) || /(?:^|\/)local\.properties$/.test(name);
function include(path,name) {
  if(generated(name) || ['SOURCE_MANIFEST.json','PACKAGE_CONTENTS.json'].includes(name)) return;
  const info=lstatSync(path);
  assert.ok(!info.isSymbolicLink(),'Filesystem link in source: '+name);
  assert.ok(info.isFile(),'Unsupported source entry: '+name);
  assert.ok(!/\.(?:jks|keystore|pfx|p12|key|pem)$/i.test(name) && (!/(?:^|\/)\.env(?:\.|$)/.test(name) || /\.example$/.test(name)),'Private file in source: '+name);
  files.push({path:name,bytes:info.size});
}
function walk(directory) {
  for(const entry of readdirSync(directory,{withFileTypes:true})) {
    const path=join(directory,entry.name),name=relative(root,path).replaceAll('\\','/');
    if(generated(name)) continue;
    assert.ok(!lstatSync(path).isSymbolicLink(),'Filesystem link in source: '+name);
    if(entry.isDirectory()) walk(path); else include(path,name);
  }
}
if(existsSync(join(root,'.git'))) {
  const names=execFileSync('git',['-C',root,'ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
  for(const name of [...new Set(names)]) include(join(root,name),name);
} else walk(root);
resolveHarnessSource(root);
for(const file of files)file.sha256=await digest(join(root,file.path));
files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
const manifest={schemaVersion:3,version:release.version,base:submissionRoot(root)?'01_Source_Code':'.',files};
const manifestFile=join(root,'SOURCE_MANIFEST.json');
if(process.argv.includes('--write-manifest'))writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n');
else if(existsSync(manifestFile))assert.deepEqual(JSON.parse(readFileSync(manifestFile,'utf8')),manifest,'Source manifest differs from current files.');
const repositoryChecksums=join(root,'docs','releases','v'+release.version,'SHA256SUMS.txt');
const checksumFile=existsSync(repositoryChecksums)?repositoryChecksums:projectPath(root,'artifacts/SHA256SUMS.txt');
let artifactsChecked=0;
if(existsSync(checksumFile)) for(const line of readFileSync(checksumFile,'utf8').trim().split(/\r?\n/)) {
 const match=/^([0-9a-fA-F]{64})  (.+)$/.exec(line);assert.ok(match,'Invalid client checksum line');
 assert.ok(!match[2].includes('..') && !/^(?:[A-Za-z]:|[\\/])/.test(match[2]),'Unsafe client checksum path');
 const path=projectPath(root,'artifacts',match[2]);
 if(!existsSync(path)) {assert.ok(!process.argv.includes('--verify-artifacts'),'Missing release asset: '+match[2]);continue;}
 assert.equal(await digest(path),match[1].toLowerCase(),'Client checksum mismatch: '+match[2]);artifactsChecked++;
}
else assert.ok(!process.argv.includes('--verify-artifacts'),'Missing release checksum manifest.');
console.log('PASS source distribution: '+files.length+' source files; pinned Harness source verified; '+artifactsChecked+' available release assets verified.');
