import { readFile, realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import { ProjectDiscovery } from '../../application/ports';
import { Project } from '../../domain/model';

function canonicalPath(file: string): string {
  // Use the same native resolver for roots and documents. Windows may expose
  // a temp directory through both its 8.3 alias and its long path.
  let existing = path.resolve(file);
  const suffix: string[] = [];
  while (true) {
    try { return path.join(realpathSync.native(existing), ...suffix); }
    catch {
      const parent = path.dirname(existing);
      if (parent === existing) return path.resolve(file);
      suffix.unshift(path.basename(existing)); existing = parent;
    }
  }
}

export class FilesystemDiscovery implements ProjectDiscovery {
  async discover(roots: readonly { root: string; manifests: readonly string[] }[]) {
    const projects = new Map<string, Project>();
    const issues: string[] = [];
    for (const workspace of roots) {
      let boundary: string;
      try { boundary = canonicalPath(await realpath(workspace.root)); }
      catch (error) { issues.push(`${workspace.root}：${error instanceof Error ? error.message : String(error)}`); continue; }
      for (const manifest of workspace.manifests) {
        try {
          const root = canonicalPath(await realpath(path.dirname(manifest)));
          const relative = path.relative(boundary, root);
          if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
          const id = process.platform === 'win32' ? root.toLowerCase() : root;
          if (projects.has(id)) continue;
          const data = parse(await readFile(path.join(root, 'pyproject.toml'), 'utf8'));
          const tool = data.tool;
          const settings = typeof tool === 'object' && tool && !Array.isArray(tool) && 'mcpywrap' in tool ? tool.mcpywrap : undefined;
          if (typeof settings === 'object' && settings && !Array.isArray(settings)) {
            projects.set(id, { id, root, label: path.basename(root), workspaceRoot: path.dirname(manifest) });
          }
        } catch (error) { issues.push(`${manifest}：${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    return { projects: [...projects.values()], issues };
  }
  containing(projects: readonly Project[], file: string): Project | undefined {
    const ordered = [...projects].sort((a, b) => b.root.length - a.root.length);
    const match = (filename: string) => ordered.find(project => {
      return [project.root, project.workspaceRoot].some(root => {
        if (!root) return false;
        const relative = path.relative(root, filename);
        return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
      });
    });
    // The ordinary editor-switch path is memory-only. Resolve filesystem aliases
    // only when a lexical lookup misses (e.g. macOS /var versus /private/var).
    return match(file) ?? match(canonicalPath(file));
  }
}
