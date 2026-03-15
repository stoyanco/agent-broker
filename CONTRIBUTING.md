# Contributing

Thanks for contributing to Agent Broker.

## Before you open a PR

1. Read [README.md](./README.md) for the project shape and intended scope.
2. Read [AGENTS.md](./AGENTS.md) if you are working with Codex or another coding agent.
3. If you are starting from a fresh clone, follow [AI_SETUP.md](./AI_SETUP.md).

## Development setup

Requirements:

- Node.js 22 or newer
- npm

Install and verify:

```bash
npm install
npm run check
```

Optional:

- Install a supported local runtime such as `gemini` or `claude` if you want to run real provider checks.
- Authenticate the chosen runtime locally before using live validation.
- Run `npm run smoke:agent` if you need an end-to-end local broker check through the built MCP server.

## Scope expectations

This repo is intentionally narrow:

- Codex remains the primary agent.
- Gemini and Claude are brokered runtimes behind a controlled broker.
- Patch-first behavior is preferred over full rewrites.
- Safety boundaries around file access and write targets should remain strict.

Please avoid widening the product scope into a general chat wrapper unless that direction is discussed explicitly.

## Pull request guidelines

- Keep changes small and reviewable.
- Include or update tests when behavior changes.
- Preserve Windows behavior when touching process launching, paths, or filesystem code.
- Update docs when the public contract, setup flow, or environment knobs change.
- Run `npm run check` before opening the PR.

## Community expectations

See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) for collaboration expectations.

## Commit guidance

- Use direct, descriptive commit messages.
- Avoid bundling unrelated changes in the same PR.

## Reporting issues

- Use the issue templates when possible.
- Include exact reproduction steps, the commands you ran, and any relevant stderr output.
- If the issue is provider-specific, say whether you used a fake fixture or the live broker path with a real runtime.

## Security

Do not open public issues for sensitive vulnerabilities. See [SECURITY.md](./SECURITY.md).
