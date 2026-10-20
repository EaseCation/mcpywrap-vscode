import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TemporarySource } from '../../application/ports';

export class Utf8TemporarySource implements TemporarySource {
  async withFile<T>(code: string, action: (file: string) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(path.join(tmpdir(), 'mcpy-vscode-'));
    try {
      const file = path.join(directory, 'selection.py');
      await writeFile(file, code, { encoding: 'utf8', mode: 0o600 });
      return await action(file);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
