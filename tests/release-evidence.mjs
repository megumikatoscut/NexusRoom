import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {dirname,join,resolve} from 'node:path'

async function sha256(path){
  const hash=createHash('sha256')
  for await(const chunk of createReadStream(path))hash.update(chunk)
  return hash.digest('hex')
}

export async function captureReleaseEvidence({hostExecutable,hostDll,apk,runtimePackage}={}){
  const files={}
  if(hostExecutable){files.exe=resolve(hostExecutable);hostDll??=join(dirname(files.exe),'NexusRoom.Host.dll')}
  if(hostDll)files.hostDll=resolve(hostDll)
  if(apk)files.apk=resolve(apk)
  if(runtimePackage){files.node=join(resolve(runtimePackage),'runtime/node/node.exe');files.harnessEntry=join(resolve(runtimePackage),'runtime/harness/node_modules/@deepseek-ai/dsh/lib/bin.js');files.harnessManifest=join(resolve(runtimePackage),'runtime/harness/runtime-manifest.json')}
  const hashes={}
  for(const [kind,path] of Object.entries(files))hashes[kind]={path,sha256:await sha256(path)}
  return hashes
}

export async function assertReleaseEvidenceUnchanged(evidence){
  for(const [kind,value] of Object.entries(evidence))assert.equal(await sha256(value.path),value.sha256,'The tested '+kind+' changed during validation')
}
