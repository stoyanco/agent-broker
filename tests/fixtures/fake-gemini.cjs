#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const mode = process.env.FAKE_GEMINI_MODE ?? "patch-success";
const resumeIndex = process.argv.indexOf("--resume");
const resumeValue = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : null;

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});

process.stdin.on("end", () => {
  void stdin;

  if (mode === "timeout") {
    setTimeout(() => {
      process.stdout.write("{}");
    }, 10_000);
    return;
  }

  if (mode === "process-error") {
    process.stderr.write("Gemini CLI fixture failed intentionally.");
    process.exit(3);
    return;
  }

  if (mode === "invalid-envelope") {
    process.stdout.write("{");
    return;
  }

  if (mode === "envelope-error") {
    process.stdout.write(
      JSON.stringify({
        error: {
          message: "Quota exceeded"
        }
      })
    );
    return;
  }

  if (mode === "invalid-inner-json") {
    process.stdout.write(
      JSON.stringify({
        response: "```json\n{\"summary\": }\n```"
      })
    );
    return;
  }

  if (mode === "unexpected-file") {
    process.stdout.write(
      JSON.stringify({
        response: JSON.stringify({
          summary: "Returned an unexpected file.",
          response: "",
          patches: [],
          files: {
            "src/pages/Other.tsx": "export default function Other() { return null; }"
          },
          notes: [],
          warnings: []
        })
      })
    );
    return;
  }

  if (mode === "unexpected-patch") {
    process.stdout.write(
      JSON.stringify({
        response: JSON.stringify({
          summary: "Returned an unexpected patch.",
          response: "",
          patches: [
            {
              path: "src/pages/Other.tsx",
              unified_diff: "@@ -1 +1 @@\n-old\n+new"
            }
          ],
          files: {},
          notes: [],
          warnings: []
        })
      })
    );
    return;
  }

  if (mode === "consult-success") {
    process.stdout.write(
      JSON.stringify({
        response: JSON.stringify({
          summary: "Shared implementation advice.",
          response:
            "Prefer a patch-first flow so Codex can review and verify the change before any full-file fallback is used.",
          patches: [],
          files: {},
          notes: ["Suggested patch-first mode."],
          warnings: []
        })
      })
    );
    return;
  }

  if (mode === "plain-text-then-repair") {
    if (stdin.includes("ORIGINAL_PROVIDER_RESPONSE:")) {
      process.stdout.write(
        JSON.stringify({
          response: JSON.stringify({
            summary: "Reformatted the original Gemini response into the broker schema.",
            response: "The settings page review is complete and no file changes are required.",
            patches: [],
            files: {},
            notes: ["Repair pass completed."],
            warnings: []
          })
        })
      );
      return;
    }

    process.stdout.write(
      JSON.stringify({
        response: "The settings page review is complete and no file changes are required."
      })
    );
    return;
  }

  if (mode === "delayed-consult-success") {
    setTimeout(() => {
      process.stdout.write(
        JSON.stringify({
          response: JSON.stringify({
            summary: "Shared delayed implementation advice.",
            response: "Polling completed and the delayed Gemini response arrived successfully.",
            patches: [],
            files: {},
            notes: ["Delayed response completed."],
            warnings: []
          })
        })
      );
    }, 50);
    return;
  }

  if (mode === "assert-model-and-cwd") {
    const modelIndex = process.argv.indexOf("--model");
    const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : null;
    const expectedCwd = process.env.EXPECTED_CWD;

    process.stdout.write(
      JSON.stringify({
        response: JSON.stringify({
          summary: "Observed launch context.",
          response: "",
          patches: [],
          files: {
            "src/pages/Settings.tsx": JSON.stringify({
              cwd: process.cwd(),
              model
            })
          },
          notes: expectedCwd && process.cwd() !== expectedCwd ? ["cwd-mismatch"] : [],
          warnings: []
        })
      })
    );
    return;
  }

  if (mode === "assert-isolated-home") {
    process.stdout.write(
      JSON.stringify({
        response: JSON.stringify({
          summary: "Observed isolated Gemini environment.",
          response: "",
          patches: [],
          files: {
            "src/pages/Settings.tsx": JSON.stringify({
              home: process.env.HOME,
              userProfile: process.env.USERPROFILE
            })
          },
          notes: [],
          warnings: []
        })
      })
    );
    return;
  }

  if (mode === "session-success") {
    const home = process.env.HOME ?? process.cwd();
    const statePath = path.join(home, ".fake-gemini-session.json");
    const existingState = fs.existsSync(statePath)
      ? JSON.parse(fs.readFileSync(statePath, "utf8"))
      : {
          calls: 0
        };
    const nextState = {
      calls: existingState.calls + 1
    };
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(nextState), "utf8");

    process.stdout.write(
      JSON.stringify({
        response: JSON.stringify({
          summary: resumeValue ? "Resumed Gemini conversation." : "Started Gemini conversation.",
          response: resumeValue
            ? `Resumed the previous conversation. Call count: ${nextState.calls}.`
            : `Started a fresh conversation. Call count: ${nextState.calls}.`,
          patches: [],
          files: {},
          notes: [
            resumeValue ? `resume=${resumeValue}` : "resume=none",
            `home=${home}`
          ],
          warnings: []
        })
      })
    );
    return;
  }

  if (mode === "rewrite-success") {
    process.stdout.write(
      JSON.stringify({
        response: JSON.stringify({
          summary: "Rewrote the settings page file.",
          response: "",
          patches: [],
          files: {
            "src/pages/Settings.tsx": [
              "export function Settings() {",
              "  return (",
              "    <section className=\"rounded-3xl border border-slate-200 bg-white p-8 shadow-sm\">",
              "      <header className=\"mb-6\">",
              "        <h1 className=\"text-2xl font-semibold text-slate-900\">Settings</h1>",
              "        <p className=\"text-sm text-slate-600\">Manage notifications and workspace defaults.</p>",
              "      </header>",
              "    </section>",
              "  );",
              "}"
            ].join("\n")
          },
          notes: ["Business logic unchanged."],
          warnings: []
        })
      })
    );
    return;
  }

  process.stdout.write(
    JSON.stringify({
      response: JSON.stringify({
        summary: "Prepared a patch for the settings page.",
        response: "",
        patches: [
          {
            path: "src/pages/Settings.tsx",
            unified_diff: [
              "--- a/src/pages/Settings.tsx",
              "+++ b/src/pages/Settings.tsx",
              "@@ -1,5 +1,5 @@",
              " export function Settings() {",
              "   return (",
              "-    <div className=\"p-4\">Settings</div>",
              "+    <section className=\"rounded-3xl border border-slate-200 bg-white p-8 shadow-sm\">Settings</section>",
              "   );",
              " }"
            ].join("\n")
          }
        ],
        files: {},
        notes: ["Business logic unchanged."],
        warnings: []
      })
    })
  );
});
