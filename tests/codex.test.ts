import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CODEX_MODEL, executeAskCodex, parseCodexExecOutput, resolveCodexModel } from "../src/codex.js";

test("resolveCodexModel uses the broker default Codex model", () => {
  assert.equal(
    resolveCodexModel({
      env: {
        ...process.env,
        CODEX_BRIDGE_MODEL: "",
        CODEX_MODEL: ""
      }
    }),
    DEFAULT_CODEX_MODEL
  );
});

test("parseCodexExecOutput parses Codex JSONL events and result payload", () => {
  const stdout = [
    JSON.stringify({
      type: "thread.started",
      thread_id: "019cee6d-1b86-7503-b9d3-05c5b10e8b88"
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_0",
        type: "agent_message",
        text: JSON.stringify({
          summary: "Shared Codex implementation advice.",
          response: "Keep adapter-specific session mapping inside the broker.",
          patches: [],
          files: {},
          notes: ["Codex consult completed."],
          warnings: []
        })
      }
    })
  ].join("\n");

  const parsed = parseCodexExecOutput(stdout);
  assert.equal(parsed.threadId, "019cee6d-1b86-7503-b9d3-05c5b10e8b88");
  assert.equal(parsed.output.summary, "Shared Codex implementation advice.");
  assert.match(parsed.output.response, /session mapping/i);
});

test("parseCodexExecOutput falls back to the output-last-message contents", () => {
  const parsed = parseCodexExecOutput(
    JSON.stringify({
      type: "thread.started",
      thread_id: "019cee6d-1b86-7503-b9d3-05c5b10e8b88"
    }),
    "Keep Codex consult-only until edit semantics are verified."
  );

  assert.match(parsed.output.response, /consult-only/i);
  assert.match(parsed.output.warnings[0] ?? "", /Codex returned plain text/i);
});

test("parseCodexExecOutput normalizes Codex consult payloads that emit file references as an array", () => {
  const parsed = parseCodexExecOutput(
    "",
    JSON.stringify({
      summary: "Grounded confirmation for the local broker smoke path.",
      response: "The broker smoke path is wired correctly.",
      patches: [],
      files: ["scripts/smoke-agent.mjs", "README.md"],
      notes: ["Grounded in the checked-in smoke script."],
      warnings: []
    })
  );

  assert.deepEqual(parsed.output.files, {});
  assert.match(parsed.output.warnings[0] ?? "", /discarded/i);
  assert.match(parsed.output.response, /broker smoke path/i);
});

test("parseCodexExecOutput rejects malformed JSONL", () => {
  assert.throws(() => parseCodexExecOutput("{"), /valid JSONL/);
});

test("executeAskCodex sends the full prompt payload through stdin", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "agent-broker-codex-test-"));

  try {
    await writeFile(path.join(projectRoot, "README.md"), "# Test\n", "utf8");
    const result = await executeAskCodex(
      {
        task: "Confirm the smoke path can carry a concrete Codex broker task.",
        project_root: projectRoot,
        files: [],
        constraints: ["tone: concise"],
        mode: "consult",
        apply: false
      },
      {
        codexCli: {
          command: process.execPath,
          preArgs: [path.join(process.cwd(), "tests", "fixtures", "fake-codex.cjs")],
          env: {
            ...process.env,
            FAKE_CODEX_MODE: "session-success"
          }
        }
      }
    );

    const promptLengthNote = result.result.notes.find((note) => note.startsWith("prompt_length="));
    assert.ok(promptLengthNote, "Expected fake Codex fixture to report prompt length.");
    const promptLength = Number.parseInt(promptLengthNote?.split("=")[1] ?? "", 10);
    assert.ok(Number.isFinite(promptLength) && promptLength > 100, `Expected prompt length > 100, received ${promptLength}`);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
