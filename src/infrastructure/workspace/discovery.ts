import { readFile, realpath, stat } from 'node:fs/promises';
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
  async discover(roots: readonly { root: string; configured: readonly string[] }[]) {
    const projects = new Map<string, Project>();
    const issues: string[] = [];
    for (const workspace of roots) {
      const explicit = workspace.configured.length > 0;
      for (const configured of explicit ? workspace.configured : ['.']) {
        try {
          const root = canonicalPath(await realpath(path.resolve(workspace.root, configured)));
          const manifest = path.join(root, 'pyproject.toml');
          if (!explicit) {
            const data = parse(await readFile(manifest, 'utf8'));
            const tool = data.tool;
            if (typeof tool !== 'object' || !tool || Array.isArray(tool) || !('mcpywrap' in tool)) continue;
          } else if (!(await stat(manifest)).isFile()) continue;
          const id = process.platform === 'win32' ? root.toLowerCase() : root;
          projects.set(id, { id, root, label: path.basename(root) });
        } catch (error) {
          if (explicit || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
            issues.push(`${path.resolve(workspace.root, configured)}：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }
    return { projects: [...projects.values()], issues };
  }
  containing(projects: readonly Project[], file: string): Project | undefined {
    // Resolve aliases such as macOS /var -> /private/var, including new files.
    file = canonicalPath(file);
    return projects.map(project => ({ project, root: canonicalPath(project.root) }))
      .sort((a, b) => b.root.length - a.root.length).find(({ root }) => {
      const relative = path.relative(root, file);
      return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    })?.project;
  }
}
