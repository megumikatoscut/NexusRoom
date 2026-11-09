import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureRuntimePath } from '../src/NexusRoom.Host/Agent/harness-runtime-path.mjs';

test('Windows runtime alias preserves deep Unicode paths and reuses the same payload', { skip: process.platform !== 'win32' }, () => {
  const workspace = mkdtempSync(join(tmpdir(), 'nexusroom-path-test-'));
  let alias;
  try {
    const runtime = join(workspace, '中文 空格'.repeat(12), 'runtime');
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, 'payload.txt'), 'immutable runtime');
    alias = ensureRuntimePath(runtime);
    assert.ok(alias.length < runtime.length);
    assert.equal(ensureRuntimePath(runtime), alias);
    assert.ok(lstatSync(alias).isSymbolicLink());
    assert.equal(readFileSync(join(alias, 'payload.txt'), 'utf8'), 'immutable runtime');
    rmSync(alias);
    mkdirSync(alias);
    assert.throws(() => ensureRuntimePath(runtime), /unexpected directory/);
    assert.equal(readFileSync(join(runtime, 'payload.txt'), 'utf8'), 'immutable runtime');
  } finally {
    if (alias) rmSync(alias, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});
