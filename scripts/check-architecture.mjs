import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
const failures = [];
async function walk(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) { await walk(file); continue; }
    if (!file.endsWith('.ts')) continue;
    const text = await readFile(file, 'utf8');
    const layer = file.split(path.sep)[1];
    for (const match of text.matchAll(/(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      const target = specifier.startsWith('.') ? path.relative('src', path.resolve(path.dirname(file), specifier)).split(path.sep)[0] : specifier;
      const allowed = { domain: [], application: ['domain', 'application'],
        infrastructure: ['domain', 'application', 'infrastructure', 'smol-toml'],
        presentation: ['domain', 'application', 'presentation', 'vscode'] }[layer];
      if (allowed && !allowed.includes(target) && !(layer === 'infrastructure' && target.startsWith('node:'))) {
        failures.push(`${file}: forbidden dependency ${specifier}`);
      }
    }
    if (/\.runtime|control\.json|python-control\.json|mcpywrap\/mcpywrap/.test(text)) failures.push(`${file}: private mcpy coupling`);
  }
}
await walk('src');
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log('Architecture boundaries passed.');
