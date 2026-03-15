# AI Setup Guide

This file is for Codex or any other AI agent that receives this repository link and needs to set the project up with minimal user hand-holding.

## What this repo is

`agent-broker` is a local MCP broker server for host-agent workflows.

It lets one local AI agent consult another runtime through a controlled tool interface.
Right now the implemented runtimes are Gemini CLI, Claude Code, and Codex CLI through:

- `ask_agent`
- `list_agents`
- `list_conversations`
- `delete_conversation`

Default operating model:

- one host agent is the primary agent
- Gemini, Claude, and Codex can all be brokered runtimes behind the scenes
- prefer `mode: "patch"` for concrete edits
- use `mode: "review"` for findings
- use `mode: "consult"` for advice
- use `mode: "rewrite"` only when full-file replacement is more reliable

Typical host environments include Codex CLI, Codex app, Gemini CLI, and other MCP-capable clients.

## Minimum prerequisites

- Node.js `>=22`
- npm

Optional, only for real live provider checks:

- local `gemini` CLI installed
- local `claude` CLI installed
- local `codex` CLI installed
- local Gemini authentication already completed
- local Claude authentication already completed
- local Codex authentication already completed
- optional broker config at `AGENT_BROKER_HOME/config.json` or `AGENT_BROKER_CONFIG` for enabled agents, allowed models, allowed project roots, conversation modes, request size limits, runtime timeouts, polling limits, and apply approval gating

Important:

- build and test do **not** require live provider access
- the test suite uses fake Gemini, Claude, and Codex fixtures by default
- live smoke testing is opt-in
- `npm run smoke:agent` now preflights broker policy before dispatching to a live runtime

## Bootstrap flow

From a fresh clone, do this:

1. Read `README.md`
2. Read `AGENTS.md`
3. Run `npm install`
4. Run `npm run build`
5. Run `npm run typecheck`
6. Run `npm test`

If the goal is to register the MCP server locally for Codex:

7. Run `npm run register:codex`

If the goal is to validate the live local agent path end-to-end:

8. Run `npm run smoke:agent`

Manual equivalent:

```bash
codex mcp add agent-broker -- node C:\absolute\path\to\dist\cli.js
```

## Success criteria

Treat setup as successful when:

- `npm run build` passes
- `npm run typecheck` passes
- `npm test` passes
- `dist/cli.js` exists after build

Treat Codex registration as successful when:

- `codex mcp list` includes `agent-broker`

The same broker can also be used from Codex app or another MCP-capable host once that client is pointed at the built `dist/cli.js` server.

## If something is missing

If Node.js is missing or too old:

- report that Node.js 22+ is required

If a provider CLI is missing:

- continue with build/test/setup work
- do not block on live provider checks unless the user asked for them

If provider auth is missing:

- continue with local build/test work
- skip live-provider validation unless explicitly requested

## Agent behavior expectations

- do not ask the user unnecessary setup questions if the repo already contains the answer
- prefer repo-local commands and documented flows over inventing new ones
- do not narrow the tool back into a Codex-only integration without explicit product direction
- do not use `apply: true` by default when testing the tool contract
- keep changes small and verifiable

## Fast summary for another AI

If you only need the shortest possible handoff:

1. `npm install`
2. `npm run build`
3. `npm run typecheck`
4. `npm test`
5. optionally `npm run register:codex`

Live provider validation is optional for normal setup.
