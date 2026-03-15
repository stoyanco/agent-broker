import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CLAUDE_MODEL, parseClaudeCliResponse, resolveClaudeModel } from "../src/claude.js";

test("resolveClaudeModel uses the broker default Claude model", () => {
  assert.equal(
    resolveClaudeModel({
      env: {
        ...process.env,
        CLAUDE_BRIDGE_MODEL: "",
        CLAUDE_MODEL: ""
      }
    }),
    DEFAULT_CLAUDE_MODEL
  );
});

test("parseClaudeCliResponse parses the Claude JSON envelope and result payload", () => {
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "123e4567-e89b-12d3-a456-426614174000",
    result: JSON.stringify({
      summary: "Shared Claude implementation advice.",
      response: "Prefer mode gating in the broker instead of adapter-specific ad hoc validation.",
      patches: [],
      files: {},
      notes: ["Claude consult completed."],
      warnings: []
    })
  });

  const parsed = parseClaudeCliResponse(stdout);
  assert.equal(parsed.summary, "Shared Claude implementation advice.");
  assert.match(parsed.response, /mode gating/i);
  assert.deepEqual(parsed.notes, ["Claude consult completed."]);
});

test("parseClaudeCliResponse normalizes plain-text Claude payloads", () => {
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Keep Claude in consult/review mode until edit semantics are verified."
  });

  const parsed = parseClaudeCliResponse(stdout);
  assert.match(parsed.response, /consult\/review mode/i);
  assert.match(parsed.warnings[0] ?? "", /Claude returned plain text/i);
});

test("parseClaudeCliResponse rejects Claude error envelopes", () => {
  const stdout = JSON.stringify({
    type: "result",
    subtype: "error_max_turns",
    is_error: true,
    result: "error"
  });

  assert.throws(() => parseClaudeCliResponse(stdout), /Claude CLI returned an error result/);
});
