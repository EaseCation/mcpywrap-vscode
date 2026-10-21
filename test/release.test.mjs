import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateRelease } from '../scripts/marketplace-release.mjs';
function repository(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'mcpy-release-policy-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Release fixture'); git('config', 'user.email', 'fixture@example.invalid');
  const commit = (version = '0.1.4', publisher = 'easecation') => {
    writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'mcpywrap-vscode', publisher, version }));
    git('add', 'package.json'); git('commit', '-m', 'fixture'); return git('rev-parse', 'HEAD');
  };
  return { cwd, git, commit };
}
test('release policy binds an existing annotated tag to main ancestry and package identity', t => {
  const f = repository(t), sha = f.commit(); f.git('update-ref', 'refs/remotes/origin/main', sha); f.git('tag', '-a', 'v0.1.4', '-m', 'release');
  assert.deepEqual(validateRelease(f.cwd, 'v0.1.4'), { sha, version: '0.1.4', file: 'mcpywrap-vscode-0.1.4.vsix' });
  for (const tag of ['', 'main', 'v0.1.4-rc.1', 'v0.1.4\nsha=wrong', '--help', 'v9.9.9']) assert.throws(() => validateRelease(f.cwd, tag));
});
test('a valid-looking tag outside main cannot be published', t => {
  const f = repository(t), main = f.commit('0.1.3'); f.git('update-ref', 'refs/remotes/origin/main', main);
  f.commit(); f.git('tag', 'v0.1.4');
  assert.throws(() => validateRelease(f.cwd, 'v0.1.4'), /origin\/main history/);
});
test('version mismatch and another publisher are rejected before credentials are requested', t => {
  const f = repository(t), sha = f.commit('0.1.3'); f.git('update-ref', 'refs/remotes/origin/main', sha); f.git('tag', 'v0.1.4');
  assert.throws(() => validateRelease(f.cwd, 'v0.1.4'), /version differ/);
  const other = f.commit('0.1.5', 'other'); f.git('update-ref', 'refs/remotes/origin/main', other); f.git('tag', 'v0.1.5');
  assert.throws(() => validateRelease(f.cwd, 'v0.1.5'), /publisher identity/);
});
