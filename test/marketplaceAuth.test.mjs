import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getOIDCCredential } from '@vscode/vsce/out/oidc.js';
const environment = { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://github.invalid/token?existing=1',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-request-token', VSCE_PAT: 'fixture-unused-pat' };
const reply = data => ({ statusCode: 200, statusMessage: 'OK', readBody: async () => JSON.stringify(data) });
test('locked vsce uses the final Marketplace OIDC contract and bound audience', async () => {
  const calls = [];
  const result = await getOIDCCredential('easecation', { environment, request: async (url, request) => {
    calls.push({ url, request });
    return calls.length === 1 ? reply({ value: 'fixture-github-jwt' }) : reply({ credential: 'fixture-short-lived-credential' });
  } });
  assert.equal(result, 'fixture-short-lived-credential');
  assert.equal(new URL(calls[0].url).searchParams.get('audience'), 'marketplace.visualstudio.com');
  assert.equal(calls[1].url, 'https://marketplace.visualstudio.com/_apis/gallery/token?api-version=7.2-preview.1');
  assert.equal(calls[1].request.headers.Authorization, 'FederatedToken fixture-github-jwt');
  assert.deepEqual(JSON.parse(calls[1].request.body), { publisherName: 'easecation' });
});
test('OIDC failures never fall back to an ambient PAT or another provider', async () => {
  let calls = 0;
  await assert.rejects(getOIDCCredential('easecation', { environment, request: async () => { calls++; throw new Error('unavailable'); } }), /unavailable/);
  assert.equal(calls, 1);
  await assert.rejects(getOIDCCredential('easecation', { environment: { VSCE_PAT: 'fixture-unused-pat' }, request: async () => { throw new Error('must not run'); } }), /No supported OIDC provider/);
});
