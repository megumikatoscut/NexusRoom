import { projectPath } from './submission-paths.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    const name = relative(root, file).replaceAll('\\', '/');
    if (entry.isDirectory()) {
      if (['third_party', 'artifacts'].includes(name) ||
          ['.git', '.local', 'node_modules', 'bin', 'obj', 'build', 'dist', 'wwwroot', '.gradle'].includes(entry.name)) continue;
      collect(file);
    } else if (entry.name.endsWith('.md') || name === 'tests/results/report/index.html') files.push(file);
  }
}
collect(root);
const release=JSON.parse(readFileSync(projectPath(root,'release.json'),'utf8'));
const issueTemplate=readFileSync(projectPath(root,'.github/ISSUE_TEMPLATE/bug_report.yml'),'utf8');
assert.ok(issueTemplate.includes(`placeholder: ${release.version} / ${release.androidVersionCode}`), 'Issue template version differs from release.json');
const failures=[]; let links=0; const external = new Set();
function anchors(file) {
  const body = readFileSync(file, 'utf8'), values = new Set(), used = new Map();
  for (const match of body.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const heading = match[1].replace(/[*`]/g, '').trim().toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
    const count = used.get(heading) || 0; used.set(heading, count + 1);
    values.add(heading + (count ? '-' + count : ''));
  }
  for (const match of body.matchAll(/\bid=["']([^"']+)["']/g)) values.add(match[1]);
  return values;
}
for (const file of files) {
  const text=readFileSync(file,'utf8');
  const name=relative(root,file).replaceAll('\\','/');
  const base=name.startsWith('scripts/templates/windows/') ? root : dirname(file);
  for (const match of text.matchAll(/\bNexusRoom(?:\s+v?|-(?:Windows-x64|Android)-)(\d+\.\d+\.\d+)/g)) {
    if (match[1] !== release.version) failures.push(name+': application version differs from release.json');
  }
  if (/(?<![\w])[A-Za-z]:[\\/](?!\/)|\/(?:Users|home)\/[^\s/]+\//.test(text)) failures.push(name+': machine-specific absolute path');
  if (/NexusRoom-Windows[^\s`|]*\.zip|Compress-Archive/i.test(text)) failures.push(file+': Windows archive distribution instruction');
  for (const match of text.matchAll(/\bscripts[\\/][A-Za-z0-9_./\\-]+\.(?:ps1|mjs|py|json)\b/g)) {
    if (!existsSync(projectPath(root,match[0].replaceAll('\\','/')))) failures.push(file+': missing script '+match[0]);
  }
  const targets = [...text.matchAll(/\[[^\]\n]+\]\(([^)]+)\)/g)].map(match => match[1]);
  if (name.endsWith('.html')) for (const match of text.matchAll(/(?:href|src)="([^"]+)"/g)) targets.push(match[1]);
  if (name === 'docs/THIRD_PARTY_NOTICES.md' || name === 'android/app/libs/README.md')
    for (const match of text.matchAll(/https?:\/\/[^\s|<>);]+/g)) external.add(match[0]);
  for (const value of targets) {
    let target=value.trim().replace(/^<|>$/g,'');
    if (/^https?:/i.test(target)) { external.add(target); continue; }
    if (/^(?:mailto:|data:)/i.test(target)) continue;
    const [path, fragment] = target.split('#');
    target=path;
    links++;
    const resolved = target ? resolve(base,decodeURIComponent(target)) : file;
    if(!existsSync(resolved)) failures.push(name+': missing local link '+target);
    else if (fragment && /\.(md|html)$/i.test(resolved) && !anchors(resolved).has(decodeURIComponent(fragment))) failures.push(name+': missing anchor '+value);
  }
}
for (const name of ['README.md','scripts/templates/windows/README.md']) {
  const body=readFileSync(projectPath(root,name),'utf8');
  if (!body.includes(release.version)) failures.push(name+': missing current application version');
  if (!name.startsWith('scripts/') && !body.includes(String(release.androidVersionCode))) failures.push(name+': Android versionCode is missing');
}
assert.deepEqual(failures,[], 'Broken current documentation links');
const externalChecks=[];
if (process.argv.includes('--external')) {
  const urls=[...external].sort();
  // Bounded batches keep upstream endpoints and this check responsive.
  for (let offset=0;offset<urls.length;offset+=4) {
    await Promise.all(urls.slice(offset,offset+4).map(async url=>{
      try {
        let response=await fetch(url,{method:'HEAD',redirect:'follow',signal:AbortSignal.timeout(12000)});
        if ([403,405].includes(response.status)) response=await fetch(url,{method:'GET',redirect:'follow',signal:AbortSignal.timeout(12000)});
        externalChecks.push({url,status:response.status,ok:response.ok});
        await response.body?.cancel();
      } catch { externalChecks.push({url,status:'network_unavailable',ok:false}); }
    }));
  }
  externalChecks.sort((a,b)=>a.url.localeCompare(b.url));
  assert.deepEqual(externalChecks.filter(item=>item.status===404 || item.status===410),[], 'Retired external documentation links');
}
const result={schemaVersion:1,date:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date()),timezone:'Asia/Shanghai',version:release.version,androidVersionCode:release.androidVersionCode,status:'passed',documents:files.length,localLinks:links,externalLinks:external.size,externalChecks};
console.log(process.argv.includes('--json') ? JSON.stringify(result,null,2) : `PASS current documentation: ${files.length} documents; ${links} local links and anchors; results included; ${externalChecks.filter(item=>item.ok).length} external links checked.`);
