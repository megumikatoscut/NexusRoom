import assert from 'node:assert/strict';
import { existsSync, readdirSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output=join(root,'PACKAGE_STATS.json');
const files=[];
function walk(directory) {
  for(const entry of readdirSync(directory,{withFileTypes:true})) {
    if(['.git','.local','node_modules','bin','obj','wwwroot','.gradle','dist','build'].includes(entry.name)) continue;
    const path=join(directory,entry.name),name=relative(root,path).replaceAll('\\','/');
    assert.ok(!lstatSync(path).isSymbolicLink(),'Filesystem link in source: '+name);
    if(entry.isDirectory()) walk(path);
    else if(!['SOURCE_MANIFEST.json','PACKAGE_STATS.json','PACKAGE_CONTENTS.json'].includes(name)) files.push({path:name,bytes:lstatSync(path).size});
  }
}
walk(root);
const payload={schemaVersion:1,scope:'01_Source_Code regular files excluding generated manifests and build/cache directories',totalFiles:files.length,totalBytes:files.reduce((n,f)=>n+f.bytes,0)};
if(process.argv.includes('--write')) writeFileSync(output,JSON.stringify(payload,null,2)+'\n');
if(process.argv.includes('--check') && existsSync(output)) assert.deepEqual(JSON.parse(readFileSync(output,'utf8')),payload,'Source inventory differs; regenerate PACKAGE_STATS.json');
console.log(JSON.stringify(payload));
