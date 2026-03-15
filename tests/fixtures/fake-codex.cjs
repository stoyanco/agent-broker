#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const mode = process.env.FAKE_CODEX_MODE ?? "consult-success";
const args = process.argv.slice(2);
const isResume = args[0] === "exec" && args[1] === "resume";
const modelIndex = args.indexOf("--model");
const modelValue = modelIndex >= 0 ? args[modelIndex + 1] : null;
const outputIndex = args.findIndex((arg) => arg === "-o" || arg === "--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
const cwdIndex = args.indexOf("-C");
const cwdValue = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd();
const stdinValue = fs.readFileSync(0, "utf8");
const promptArgument = args[args.length - 1] ?? "";
const promptValue = promptArgument === "-" ? stdinValue : promptArgument;
const resumeSessionId = isResume ? args[args.length - 2] ?? null : null;

function emitJsonlEvent(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function writeLastMessage(text) {
  if (!outputPath) {
    return;
  }

  fs.writeFileSync(outputPath, text, "utf8");
}

function emitSuccess(text, threadId) {
  emitJsonlEvent({
    type: "thread.started",
    thread_id: threadId
  });
  emitJsonlEvent({
    type: "turn.started"
  });
  emitJsonlEvent({
    type: "item.completed",
    item: {
      id: "item_0",
      type: "agent_message",
      text
    }
  });
  emitJsonlEvent({
    type: "turn.completed",
    usage: {
      input_tokens: 100,
      cached_input_tokens: 0,
      output_tokens: 20
    }
  });
  writeLastMessage(text);
}

if (mode === "timeout") {
  setTimeout(() => {
    process.stdout.write("{}");
  }, 10_000);
  return;
}

if (mode === "process-error") {
  process.stderr.write("Codex CLI fixture failed intentionally.");
  process.exit(5);
  return;
}

if (mode === "invalid-jsonl") {
  process.stdout.write("{");
  return;
}

if (mode === "consult-success") {
  emitSuccess(
    JSON.stringify({
      summary: "Shared Codex implementation advice.",
      response: "Prefer broker-level policy discovery so host agents can adapt before dispatching work.",
      patches: [],
      files: {},
      notes: ["Codex consult completed."],
      warnings: []
    }),
    "fake-codex-thread"
  );
  return;
}

if (mode === "delayed-consult-success") {
  setTimeout(() => {
    emitSuccess(
      JSON.stringify({
        summary: "Shared delayed Codex implementation advice.",
        response: "Polling completed and the delayed Codex response arrived successfully.",
        patches: [],
        files: {},
        notes: ["Delayed Codex response completed."],
        warnings: []
      }),
      "fake-codex-thread-delayed"
    );
  }, 50);
  return;
}

if (mode === "session-success") {
  const threadId = resumeSessionId ?? `fake-codex-thread-${crypto.randomUUID()}`;
  const statePath = path.join(os.tmpdir(), `fake-codex-${threadId}.json`);
  const existingState = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, "utf8"))
    : {
        calls: 0
      };
  const nextState = {
    calls: existingState.calls + 1
  };
  fs.writeFileSync(statePath, JSON.stringify(nextState), "utf8");

  emitSuccess(
    JSON.stringify({
      summary: resumeSessionId ? "Resumed Codex conversation." : "Started Codex conversation.",
      response: resumeSessionId
        ? `Resumed the previous Codex conversation. Call count: ${nextState.calls}.`
        : `Started a fresh Codex conversation. Call count: ${nextState.calls}.`,
      patches: [],
      files: {},
      notes: [
        `resume=${resumeSessionId ?? "none"}`,
        `thread_id=${threadId}`,
        `prompt_length=${promptValue.length}`
      ],
      warnings: []
    }),
    threadId
  );
  return;
}

if (mode === "assert-model-and-cwd") {
  emitSuccess(
    JSON.stringify({
      summary: "Observed Codex launch context.",
      response: "",
      patches: [],
      files: {
        "src/pages/Settings.tsx": JSON.stringify({
          model: modelValue,
          cwd: cwdValue
        })
      },
      notes: [],
      warnings: []
    }),
    "fake-codex-thread-assert"
  );
  return;
}

emitSuccess(
  JSON.stringify({
    summary: "Shared Codex fallback advice.",
    response: "Codex fallback fixture path completed.",
    patches: [],
    files: {},
    notes: [],
    warnings: []
  }),
  "fake-codex-thread-fallback"
);
