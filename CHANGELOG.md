# Changelog

All notable changes to this project should be documented in this file.

The format is intentionally simple and human-maintained while the package remains private on npm.

## [Unreleased]

### Added

- End-to-end MCP stdio integration coverage for tool listing, polling, and failure isolation.
- A generic `ask_agent` MCP surface with `list_agents` discovery and explicit `conversation_mode` / `conversation_id` support.
- A local `npm run smoke:agent` command for real broker validation through the built MCP server.
- A Claude adapter for `ask_agent` with consult/review support, resumable conversations, and MCP end-to-end coverage.
- A Codex adapter for `ask_agent` with consult/review support, resumable conversations, and live smoke coverage.
- Broker conversation management through `list_conversations`, `delete_conversation`, persisted state, and retention cleanup.
- Broker policy controls for allowed project roots, apply approval, request size limits, timeouts, poll limits, and model allowlists.
- Maintainer release guidance, release hygiene checks, and versioning policy documentation.
- CI tarball verification with `npm pack --dry-run`.
- Community and maintainer metadata including a code of conduct, CODEOWNERS, and GitHub release-note categories.

### Changed

- Refactored the server from a Gemini-specific bridge into a local agent broker with persistent conversation records and generic job handling.
- Hardened Gemini process handling and broker job lifecycle behavior for long-running and failing requests.
- Hardened the Codex adapter around real CLI behavior, including stdin-based prompting and more tolerant consult payload normalization.
- Hardened request validation, `project_root` errors, `apply=true` edit guarantees, and unified diff hunk validation.
- Expanded README guidance with architecture, examples, troubleshooting, workflow explanation, and support expectations.

## [0.4.0] - 2026-03-13

### Added

- AI bootstrap guidance in `AI_SETUP.md`.
- Public project logo and refreshed project presentation.

### Changed

- Project naming and package metadata were aligned under `agent-broker`.

## [Initial public release]

### Added

- Local MCP bridge for Codex-first Gemini consultation.
- The original Gemini-specific MCP tool surfaces.
- Patch, rewrite, consult, and review execution modes.
- Safety checks for allowed files, blocked paths, and validated write targets.
- TypeScript build, test suite, and Codex registration helper.
