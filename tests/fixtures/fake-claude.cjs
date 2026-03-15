#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const mode = process.env.FAKE_CLAUDE_MODE ?? "consult-success";
const resumeIndex = process.argv.indexOf("--resume");
const resumeValue = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : null;
const sessionIdIndex = process.argv.indexOf("--session-id");
const sessionIdValue = sessionIdIndex >= 0 ? process.argv[sessionIdIndex + 1] : null;
const modelIndex = process.argv.indexOf("--model");
const modelValue = modelIndex >= 0 ? process.argv[modelIndex + 1] : null;

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});

function writeResult(payload) {
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionIdValue ?? resumeValue ?? "fake-claude-session",
      result: JSON.stringify(payload)
    })
  );
}

process.stdin.on("end", () => {
  void stdin;

  if (mode === "timeout") {
    setTimeout(() => {
      process.stdout.write("{}");
    }, 10_000);
    return;
  }

  if (mode === "process-error") {
    process.stderr.write("Claude CLI fixture failed intentionally.");
    process.exit(4);
    return;
  }

  if (mode === "invalid-envelope") {
    process.stdout.write("{");
    return;
  }

  if (mode === "error-result") {
    process.stdout.write(
      JSON.stringify({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        result: "Claude fixture error"
      })
    );
    return;
  }

  if (mode === "consult-success") {
    writeResult({
      summary: "Shared Claude implementation advice.",
      response: "Prefer a thin broker core with adapter-specific session handling and explicit mode gating.",
      patches: [],
      files: {},
      notes: ["Claude consult completed."],
      warnings: []
    });
    return;
  }

  if (mode === "delayed-consult-success") {
    setTimeout(() => {
      writeResult({
        summary: "Shared delayed Claude implementation advice.",
        response: "Polling completed and the delayed Claude response arrived successfully.",
        patches: [],
        files: {},
        notes: ["Delayed Claude response completed."],
        warnings: []
      });
    }, 50);
    return;
  }

  if (mode === "session-success") {
    const sessionKey = sessionIdValue ?? resumeValue ?? "fake-claude-session";
    const statePath = path.join(os.tmpdir(), `fake-claude-${sessionKey}.json`);
    const existingState = fs.existsSync(statePath)
      ? JSON.parse(fs.readFileSync(statePath, "utf8"))
      : {
          calls: 0
        };
    const nextState = {
      calls: existingState.calls + 1
    };
    fs.writeFileSync(statePath, JSON.stringify(nextState), "utf8");

    writeResult({
      summary: resumeValue ? "Resumed Claude conversation." : "Started Claude conversation.",
      response: resumeValue
        ? `Resumed the previous Claude conversation. Call count: ${nextState.calls}.`
        : `Started a fresh Claude conversation. Call count: ${nextState.calls}.`,
      patches: [],
      files: {},
      notes: [
        `resume=${resumeValue ?? "none"}`,
        `session_id=${sessionIdValue ?? "none"}`
      ],
      warnings: []
    });
    return;
  }

  if (mode === "assert-model") {
    writeResult({
      summary: "Observed Claude launch context.",
      response: "",
      patches: [],
      files: {
        "src/pages/Settings.tsx": JSON.stringify({
          model: modelValue,
          cwd: process.cwd()
        })
      },
      notes: [],
      warnings: []
    });
    return;
  }

  writeResult({
    summary: "Shared Claude fallback advice.",
    response: "Claude fallback fixture path completed.",
    patches: [],
    files: {},
    notes: [],
    warnings: []
  });
});
