import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Registry, parseRawGrammar, INITIAL } from 'vscode-textmate';
import { loadWASM, createOnigScanner, createOnigString } from 'vscode-oniguruma';

test('native TextMate tokens follow Studio rule priority and timestamp/prefix colors', async () => {
  const wasm = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
  await loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const registry = new Registry({ onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
    loadGrammar: async name => name === 'text.mcpy-log' ? parseRawGrammar(readFileSync('syntaxes/mcpy-log.tmLanguage.json', 'utf8'), 'mcpy-log.json') : null });
  const grammar = await registry.loadGrammar('text.mcpy-log'); assert.ok(grammar);
  const scopeAt = (line: string, needle: string) => grammar.tokenizeLine(line, INITIAL).tokens.find(token => token.startIndex <= line.indexOf(needle) && token.endIndex > line.indexOf(needle))?.scopes.join(' ');
  const line = '⟦project · host a123⟧ [2026-10-21 10:00:00,001] [ERROR][Engine] broken';
  assert.match(scopeAt(line, '[2026')!, /comment.mcpy.timestamp/);
  assert.match(scopeAt(line, '[ERROR]')!, /invalid.mcpy.error/);
  assert.match(scopeAt(line, '[Engine]')!, /entity.name.tag.mcpy.engine/);
  for (const [text, expected] of [
    ['[Mod] Error: broken', 'invalid.mcpy.error'], ['[Mod] WARN message', 'markup.deleted.mcpy.warning'],
    ['[Probe] ready', 'keyword.control.mcpy.tag'], ['LoadWindowsAddonPy init', 'entity.name.tag.mcpy.load'],
    ['finished successfully', 'markup.inserted.mcpy.success'], ['listener ready', 'markup.deleted.mcpy.event'],
    ['{"ok":true}', 'constant.language.mcpy.response'], ['ValueError: bad', 'invalid.mcpy.error']
  ] as const) assert.ok(scopeAt(`⟦project · client a123⟧ ${text}`, text)?.includes(expected), text);
  registry.dispose();
});
