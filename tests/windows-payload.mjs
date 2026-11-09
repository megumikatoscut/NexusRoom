import { projectPath } from '../scripts/submission-paths.mjs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
export function windowsPayload(root, version) {
  return execFileSync(projectPath(root, 'artifacts', `NexusRoom-Windows-x64-${version}.exe`), ['--extract-only'], { encoding: 'utf8', windowsHide: true, timeout: 600000 }).trim();
}
