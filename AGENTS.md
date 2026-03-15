# AGENTS.md

Use the local MCP tool `ask_agent` when the current host agent would benefit from consulting another agent runtime as a second model.

If you need repo bootstrap or MCP setup steps from a fresh clone, read `AI_SETUP.md` first.

Typical cases:

- `mode: "consult"` for advice, alternatives, and tradeoffs
- `mode: "review"` for bugs, regressions, and missing validation
- `mode: "patch"` for targeted unified diffs
- `mode: "rewrite"` only when a full-file rewrite is more reliable than a patch

Gemini is especially useful for UI polish and design-oriented edits, but the broker surface is not limited to UI work and supports multiple runtimes through the same `ask_agent` entrypoint.

Do not use `apply: true` by default. Prefer returning patches or rewrite artifacts to the host agent first, then let the host agent verify and integrate the result.

Before calling `ask_agent`, package the request clearly. Include whatever matters for the task:

- scope of the change or review
- approved facts
- forbidden claims or assumptions
- exact files to inspect
- quality bar or validation focus
- any copy that must be preserved
- the target `agent`
- the `conversation_mode` and `conversation_id` when continuity is required

Supported structured prefixes in `constraints`:

- `audience:`
- `approved facts:`
- `forbidden claims:`
- `required sections:`
- `tone:`
- `cta:` or `cta text:`
- `preserve:` or `preserve copy:`

After the tool returns, the host agent should still run build, typecheck, tests, or any other relevant verification and repair integration issues itself.

If `ask_agent` returns `status: "running"`, poll it again with `job_id` until it returns `status: "completed"` or a real error.

Use `list_agents` when the host agent needs to discover which runtimes are currently enabled and what capabilities they support.
