import { projectPath } from './submission-paths.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
const root=resolve(import.meta.dirname,'..'),base=projectPath(root,'tests/results');
const release=JSON.parse(await readFile(projectPath(root,'release.json'),'utf8'));
const files=[];
async function walk(directory) {
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    const path=join(directory,entry.name);
    assert.ok(!entry.isSymbolicLink(),'Results must be regular public files');
    if(entry.isDirectory()) await walk(path);
    else {const bytes=await readFile(path);files.push({path:relative(base,path).replaceAll('\\','/'),bytes:(await stat(path)).size,sha256:createHash('sha256').update(bytes).digest('hex')});}
  }
}
await walk(base);files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
const manifest={schemaVersion:3,version:release.version,androidVersionCode:release.androidVersionCode,base:'NexusRoom_Final_Submission_v1.0.0/06_Engineering_Evidence/Verification/Results',measurements:'audit/measurement-manifest.json',files};
const output=projectPath(root,'docs/FINAL_TEST_RESULTS_MANIFEST.json');
if(process.argv.includes('--write')) await writeFile(output,JSON.stringify(manifest,null,2)+'\n');
else assert.deepEqual(JSON.parse(await readFile(output,'utf8')),manifest,'Result manifest differs; run update-results-manifest.mjs --write after publishing reports');
console.log(`PASS result manifest: ${files.length} files; current version ${release.version}.`);
