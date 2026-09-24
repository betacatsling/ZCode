import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveNativeSessionDbPath } from './index.js';

test('native path uses configured relative value and launch cwd without opening DB', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'native-path-'));
  try {
    const path = resolveNativeSessionDbPath({ cwd, env: { ZCODE_SESSION_DB_PATH: 'local/custom.sqlite' }, skipUserConfig: true });
    assert.equal(path, join(cwd, 'local/custom.sqlite'));
    assert.equal(existsSync(join(cwd, 'local')), false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
