# Changelog

All notable changes to this project should be documented in this file.

The format is intentionally simple and human-maintained while the package remains private on npm.

## [Unreleased]

## [0.1.0] - 2026-03-15

### Added

- A local MCP broker server with a generic `ask_agent` surface for brokered consultation, review, patch, and rewrite workflows.
- Local runtime adapters for Gemini CLI, Claude Code, and Codex with a shared broker contract.
- End-to-end MCP stdio integration coverage for tool listing, polling, conversation continuity, and failure isolation.
- Broker conversation management through `list_conversations`, `delete_conversation`, persisted state, and retention cleanup.
- Broker policy controls for allowed project roots, model allowlists, request size limits, apply approval, timeouts, and poll limits.
- A local `npm run smoke:agent` command for real broker validation through the built MCP server.
- Maintainer docs and project metadata including `AI_SETUP.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `RELEASE.md`, and provider capability tracking.

### Changed

- Refactored the original Gemini-specific bridge into a host-agent-neutral local broker with persistent conversation records and generic job handling.
- Hardened Gemini process handling with stricter output guidance, repair-pass recovery for plain-text replies, and more reliable timeout behavior.
- Expanded README guidance with architecture, MCP contract details, host-agent usage examples, troubleshooting, and support expectations.
