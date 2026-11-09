// Resolve the submission layout while retaining standalone-source compatibility.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, relative } from 'node:path';
export function submissionRoot(sourceRoot) {
  const parent = dirname(resolve(sourceRoot));
  return existsSync(join(parent, '02_Release_Artifacts')) && existsSync(join(parent, '06_Engineering_Evidence')) ? parent : null;
}
export function projectPath(sourceRoot, ...parts) {
  const root = resolve(sourceRoot);
  const full = resolve(root, ...parts);
  const name = relative(root, full).replaceAll('\\', '/');
  const submission = submissionRoot(root);
  if (!submission) return full;
  const prefix = basename(submission) + '/';
  if (name.startsWith(prefix)) return join(submission, name.slice(prefix.length));
  if (/^(?:0[1-7]_[^/]+)(?:\/|$)/.test(name)) return join(submission, name);
  if (name === 'tests/results' || name.startsWith('tests/results/')) return join(submission, '06_Engineering_Evidence/Verification/Results', name.slice(13));
  if (name === 'tests/evidence' || name.startsWith('tests/evidence/')) return join(submission, '06_Engineering_Evidence/Verification/Runtime_Evidence', name.slice(14));
  if (/^docs\/(?:PACKAGING_VALIDATION|FINAL_TEST_RESULTS_MANIFEST)\.json$/.test(name)) return join(submission, '06_Engineering_Evidence/Verification', name.slice(5));
  if (name === 'docs/VOICE_PRESENTATION_VALIDATION.json') return join(submission, '06_Engineering_Evidence/Verification/Runtime_Evidence/VOICE_PRESENTATION_VALIDATION.json');
  if (name === 'artifacts' || name.startsWith('artifacts/')) {
    const rest = name.slice(10);
    if (/^NexusRoom-Windows[^/]*\.exe$/.test(rest)) return join(submission, '02_Release_Artifacts/Windows', rest);
    if (/^NexusRoom-Android[^/]*\.apk$/.test(rest)) return join(submission, '02_Release_Artifacts/Android', rest);
    return join(submission, '02_Release_Artifacts', rest);
  }
  return full;
}

// Fresh test outputs are disposable and must never replace submitted historical evidence.
export function generatedEvidencePath(sourceRoot, ...parts) {
  const version = JSON.parse(readFileSync(join(sourceRoot, 'release.json'), 'utf8')).version;
  const cache = process.env.NEXUS_CACHE_DIR || join(homedir(), '.cache/NexusRoom/build-cache/v' + version);
  const base = resolve(process.env.NEXUS_TEST_EVIDENCE_DIR || join(cache, 'current-validation'));
  const name = parts.join('/').replace(/^tests\/evidence\/?/, '');
  const output = resolve(base, name);
  if (output !== base && !output.startsWith(base + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('Generated evidence path escaped its output directory.');
  return output;
}
