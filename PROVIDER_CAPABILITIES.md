# Provider Capabilities

Last checked: 2026-03-14

This file tracks broker-relevant runtime capabilities for agent environments that may sit behind this repo's MCP layer.

Scope notes:
- This table tracks runtime and orchestration capabilities, not raw model quality.
- Prefer official docs or direct local verification before changing a row.
- `Yes` means the capability is explicitly documented or already verified locally.
- `Partial` means some of the behavior is documented, but not in a clearly automation-friendly or provider-native way.
- `Unknown` means not yet confirmed from an official source.

## Verified runtimes

| Runtime | MCP client support | Resumable sessions | Non-interactive/session reuse for automation | Session identifier exposed for automation | Notes | Official sources |
| --- | --- | --- | --- | --- | --- | --- |
| Codex CLI / Codex app | Yes | Yes | Yes | Yes | Verified locally on 2026-03-14 via `codex --help`, `codex mcp --help`, `codex resume --help`, and `codex exec resume --help`. Codex has native MCP management and explicit resume-by-session-id flows in both interactive and non-interactive modes. | Local CLI verification on 2026-03-14; [OpenAI developer portal](https://developers.openai.com/) |
| Gemini CLI | Yes | Yes | Yes | Yes | Sessions are auto-saved locally and are project-scoped. `gemini --resume`, `gemini -r "latest" "query"`, and resume by session UUID are documented. Headless JSONL output documents an `init` event with session metadata. | [Gemini CLI MCP servers](https://geminicli.com/docs/tools/mcp-server/), [Gemini session management](https://geminicli.com/docs/cli/session-management/), [Gemini CLI reference](https://geminicli.com/docs/cli/cli-reference/), [Gemini headless mode](https://geminicli.com/docs/cli/headless/) |
| Claude Code | Yes | Yes | Yes | Yes | Claude Code can connect to MCP servers. Previous conversations can be resumed with `--continue` or `--resume`. Headless docs document `--resume <session-id>` in automation flows, and the SDK docs document a `session_id` emitted in the init message. | [Claude Code MCP](https://code.claude.com/docs/en/mcp), [Claude Code CLI reference](https://docs.claude.com/en/docs/claude-code/cli-usage), [Claude Code session management](https://platform.claude.com/docs/en/agent-sdk/sessions), [Claude Code common workflows](https://docs.anthropic.com/en/docs/claude-code/common-workflows) |
| Mistral Vibe | Yes | Yes | Yes | Partial | Vibe documents MCP server configuration, a non-interactive `--prompt` mode with JSON/streaming output, and session continuation via `--continue` or `--resume SESSION_ID`. The docs confirm session IDs exist, but do not clearly document a dedicated machine-readable session-id event for automation. | [Mistral Vibe introduction](https://docs.mistral.ai/mistral-vibe/introduction), [Mistral Vibe quickstart](https://docs.mistral.ai/mistral-vibe/introduction/quickstart), [Mistral Vibe configuration](https://docs.mistral.ai/mistral-vibe/introduction/configuration) |

## Pending verification

| Runtime | MCP client support | Resumable sessions | Non-interactive/session reuse for automation | Session identifier exposed for automation | Notes | Official sources |
| --- | --- | --- | --- | --- | --- | --- |
| Kimi Playground | Yes | Unknown | No | Unknown | Official Moonshot sources confirm Playground MCP support, but this is a web playground, not a documented local CLI/runtime with resumable automation flows. | [Kimi Playground announcement](https://platform.moonshot.ai/blog/posts/ICYMI_The_Kimi_Playground), [Moonshot changelog](https://platform.moonshot.ai/blog/posts/changelog) |
| Kimi CLI / Moonshot local agent runtime | Unknown | Unknown | Unknown | Unknown | Moonshot's official changelog says CLI docs were updated on 2025-10-27, but I did not find a stable official CLI/session page with enough detail to mark capabilities confidently. | [Moonshot changelog](https://platform.moonshot.ai/blog/posts/changelog) |
| GLM Coding Plan via external coding tools | Partial | Partial | Partial | Unknown | Official Z.ai docs position GLM as a backend used inside host tools such as Claude Code, OpenCode, Cline, and others. MCP support exists through GLM-provided MCP servers and host-tool integrations, but a standalone GLM coding CLI/runtime with its own documented session model is not confirmed here. | [GLM Coding quick start](https://docs.bigmodel.cn/cn/coding-plan/quick-start), [GLM Coding FAQ](https://docs.bigmodel.cn/cn/coding-plan/faq), [Coding Tool Helper](https://docs.bigmodel.cn/cn/coding-plan/tool/coding-tool-helper), [Vision MCP Server](https://docs.bigmodel.cn/cn/coding-plan/mcp/vision-mcp-server) |
| GLM standalone agent runtime | Unknown | Unknown | Unknown | Unknown | Need official local runtime docs. Current official docs emphasize GLM inside third-party coding tools more than a first-party standalone agent shell. | [GLM Coding overview](https://docs.bigmodel.cn/cn/coding-plan/overview) |

## Broker implications

| Runtime | Broker conclusion |
| --- | --- |
| Codex CLI / Codex app | A local MCP broker can preserve Codex continuity too, because Codex already exposes resumable sessions and non-interactive resume flows keyed by session ID. |
| Gemini CLI | A local MCP broker can preserve a long-lived Gemini thread by storing a broker-level conversation ID and mapping it to Gemini's underlying session ID. |
| Claude Code | A local MCP broker can preserve Claude continuity as well, but the implementation should treat Claude's session handle as adapter-specific rather than assuming Gemini-compatible behavior. |
| Mistral Vibe | A local MCP broker can likely preserve Mistral continuity as well, but should treat session lookup as adapter-specific until Mistral documents a cleaner machine-readable session-id contract. |

## Current design rule

For this repo, session continuity should be implemented as an adapter capability, not as a universal assumption:
- broker API may expose `conversation_id`
- each adapter decides whether and how that maps to provider-native session state
- patch/apply flows should default to fresh or explicitly chosen sessions when determinism matters
