import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const publisher = 'easecation';
const extension = 'mcpywrap-vscode';
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export function validateRelease(cwd, tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) throw new Error('Select an existing stable release tag, for example v0.1.4.');
  const sha = git(cwd, ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]);
  try { git(cwd, ['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main']); }
  catch { throw new Error('Release tag must belong to origin/main history.'); }
  const manifest = JSON.parse(git(cwd, ['show', `${sha}:package.json`]));
  if (tag !== `v${manifest.version}`) throw new Error('Tag and extension package version differ.');
  if (manifest.publisher !== publisher || manifest.name !== extension) throw new Error('Unexpected extension or publisher identity.');
  return { sha, version: manifest.version, file: `${extension}-${manifest.version}.vsix` };
}
export function verifyPackage(file, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Invalid expected package version.');
  // Release jobs run on Ubuntu. Inspect the existing artifact without extracting it.
  const unzip = args => execFileSync('unzip', args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  const manifest = JSON.parse(unzip(['-p', file, 'extension/package.json']));
  if (manifest.publisher !== publisher || manifest.name !== extension || manifest.version !== version) {
    throw new Error('VSIX identity/version does not match the selected release.');
  }
  const xml = unzip(['-p', file, 'extension.vsixmanifest']);
  const identity = xml.match(/<Identity\s[^>]+>/)?.[0] ?? '';
  const attribute = name => identity.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1];
  if (attribute('Publisher') !== publisher || attribute('Id') !== extension || attribute('Version') !== version || attribute('TargetPlatform')) {
    throw new Error('VSIX XML identity is inconsistent or the package is not universal.');
  }
  const names = unzip(['-Z1', file]).trim().split('\n');
  if (names.some(name => /(^|\/)(\.git|\.github|\.local-notes|node_modules|\.env)(\/|$)/.test(name))) {
    throw new Error('VSIX includes development-only or credential paths.');
  }
  return { publisher, extension, version, file, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
}
function outputs(values) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n\`\`\`json\n${JSON.stringify(values, null, 2)}\n\`\`\`\n`);
  console.log(JSON.stringify(values, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];
  if (command === 'tag') outputs(validateRelease(process.cwd(), process.env.RELEASE_TAG));
  else if (command === 'package') outputs(verifyPackage(process.env.VSIX_PATH, process.env.RELEASE_VERSION));
  else throw new Error('Expected tag or package command.');
}
