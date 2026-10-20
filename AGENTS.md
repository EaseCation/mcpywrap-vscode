# Project boundaries

- This is an independent VS Code extension, not a Python/mcpywrap subpackage.
- `domain/` has no imports. `application/` imports domain and its own ports only.
- `infrastructure/` implements ports with public CLI calls. No Python imports,
  `.runtime` inspection, private socket clients, game hooks or mcpy source dependencies.
- `presentation/` imports application/domain and VS Code APIs only. Composition
  belongs to `extension.ts`. CLI option names and raw JSON remain in infrastructure.
- Project scripts, dependency resolution, deployment, game processes and locks
  are owned by mcpy. Do not reimplement them here or add mcpy-to-extension callbacks.
- Unknown mutation outcomes are never retried automatically. Closing views or
  deactivating the extension never stops game sessions.
- Evolve product scenarios, interaction states and CLI compatibility docs before
  changing observable behavior. Distinguish available entrypoints from verified effects.
- Run `npm run check` and `npm run package` for code changes. Game/DAP support
  requires explicit version/platform/side verification; mocked tests cannot prove it.
