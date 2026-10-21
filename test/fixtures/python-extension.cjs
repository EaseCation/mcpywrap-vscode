// Independent implementation of the documented Python environment API for host tests.
const vscode = require('vscode');
exports.activate = context => {
  const emitter = new vscode.EventEmitter();
  let changed = false;
  context.subscriptions.push(emitter, vscode.commands.registerCommand('mcpyFixture.changePython', () => { changed = true; emitter.fire({}); }));
  return { environments: {
    getActiveEnvironmentPath(resource) {
      const id = (changed ? 'changed-' : '') + (resource.path.includes('project-b') ? 'b' : 'a');
      return { id, path: '/fixture/' + id + '/bin/python' };
    },
    async resolveEnvironment(environment) { return { executable: { uri: vscode.Uri.file(environment.path) }, environment: { name: environment.id } }; },
    onDidChangeActiveEnvironmentPath: emitter.event
  } };
};
