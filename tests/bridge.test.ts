import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_CONTEXT_CHARS,
  applyUnifiedDiff,
  applyValidatedArtifacts,
  buildPromptBody,
  createGeminiRunner,
  executeAskGemini,
  loadProjectFiles,
  normalizeRelativePath,
  parseBriefConstraints,
  parseGeminiCliResponse,
  prepareGeminiEnvironment,
  resolveGeminiLaunch,
  stripJsonFence,
  systemPrompt,
  validateResponseArtifacts
} from "../src/bridge.js";

const fixtureProjectRoot = path.resolve("tests/fixtures/demo-project");
const fakeGeminiScript = path.resolve("tests/fixtures/fake-gemini.cjs");

test("normalizeRelativePath normalizes Windows separators", () => {
  assert.equal(normalizeRelativePath("src\\pages\\Settings.tsx"), "src/pages/Settings.tsx");
});

test("loadProjectFiles accepts an allowed file", async () => {
  const files = await loadProjectFiles({
    task: "Refresh the settings page",
    project_root: fixtureProjectRoot,
    files: ["src/pages/Settings.tsx"],
    constraints: ["tailwind only"],
    mode: "patch"
  });

  assert.equal(files.length, 1);
  assert.equal(files[0].normalizedPath, "src/pages/Settings.tsx");
  assert.match(files[0].content, /Settings/);
});

test("loadProjectFiles blocks traversal", async () => {
  await assert.rejects(
    loadProjectFiles({
      task: "Refresh the settings page",
      project_root: fixtureProjectRoot,
      files: ["../package.json"],
      constraints: []
    }),
    /Path traversal is not allowed/
  );
});

test("askGeminiInputSchema rejects duplicate file entries", async () => {
  await assert.rejects(
    executeAskGemini({
      task: "Review the settings page",
      project_root: fixtureProjectRoot,
      files: ["src/pages/Settings.tsx", "./src/pages/Settings.tsx"],
      constraints: [],
      mode: "review",
      apply: false
    }),
    /Duplicate file entries/
  );
});

test("loadProjectFiles blocks unsafe files", async () => {
  await assert.rejects(
    loadProjectFiles({
      task: "Refresh the settings page",
      project_root: fixtureProjectRoot,
      files: ["src/node_modules/Hack.tsx"],
      constraints: []
    }),
    /blocked directory/
  );
});

test("loadProjectFiles rejects a missing project_root with a clearer message", async () => {
  await assert.rejects(
    loadProjectFiles({
      task: "Refresh the settings page",
      project_root: path.join(fixtureProjectRoot, "missing-root"),
      files: ["src/pages/Settings.tsx"],
      constraints: []
    }),
    /project_root does not exist/
  );
});

test("loadProjectFiles rejects a project_root that is a file", async () => {
  await assert.rejects(
    loadProjectFiles({
      task: "Refresh the settings page",
      project_root: path.join(fixtureProjectRoot, "src", "pages", "Settings.tsx"),
      files: ["src/pages/Settings.tsx"],
      constraints: []
    }),
    /project_root must point to a directory/
  );
});

test("buildPromptBody includes task, constraints, and file contents", async () => {
  const files = await loadProjectFiles({
    task: "Refresh the settings page",
    project_root: fixtureProjectRoot,
    files: ["src/pages/Settings.tsx"],
    constraints: ["tailwind only", "keep business logic"],
    mode: "patch"
  });

  const prompt = buildPromptBody(
    {
      task: "Refresh the settings page",
      project_root: fixtureProjectRoot,
      files: ["src/pages/Settings.tsx"],
      constraints: ["tailwind only", "keep business logic"],
      mode: "patch"
    },
    files
  );

  assert.match(prompt, /TASK:\nRefresh the settings page/);
  assert.match(prompt, /MODE:\npatch/);
  assert.match(prompt, /OUTPUT_REQUIREMENTS:/);
  assert.match(prompt, /Return exactly one JSON object/);
  assert.match(prompt, /EXTRA_CONSTRAINTS:\n- tailwind only\n- keep business logic/);
  assert.match(prompt, /CALLER_EXPECTATIONS:/);
  assert.match(prompt, /AUDIENCE:\n- not provided/);
  assert.match(prompt, /FILE: src\/pages\/Settings\.tsx/);
});

test("parseBriefConstraints extracts structured brief fields from constraints", () => {
  const parsed = parseBriefConstraints([
    "audience: frontend leads, product engineers",
    "approved facts: local repo access; shell command execution",
    "forbidden claims: system-wide hotkeys | privacy guarantees",
    "required sections: hero, workflow",
    "tone: practical, technical",
    "cta: Open a project in Codex",
    "preserve: local context matters",
    "responsive layout",
    "accessible UI"
  ]);

  assert.deepEqual(parsed.audience, ["frontend leads", "product engineers"]);
  assert.deepEqual(parsed.approvedFacts, ["local repo access", "shell command execution"]);
  assert.deepEqual(parsed.forbiddenClaims, ["system-wide hotkeys", "privacy guarantees"]);
  assert.deepEqual(parsed.requiredSections, ["hero", "workflow"]);
  assert.deepEqual(parsed.tone, ["practical", "technical"]);
  assert.deepEqual(parsed.ctaText, ["Open a project in Codex"]);
  assert.deepEqual(parsed.preserveCopy, ["local context matters"]);
  assert.deepEqual(parsed.extraConstraints, ["responsive layout", "accessible UI"]);
});

test("buildPromptBody emits structured brief sections when provided", async () => {
  const files = await loadProjectFiles({
    task: "Refresh the settings page",
    project_root: fixtureProjectRoot,
    files: ["src/pages/Settings.tsx"],
    constraints: [
      "audience: frontend developers",
      "approved facts: local repo access",
      "forbidden claims: privacy guarantees",
      "cta: Open a project in Codex"
    ],
    mode: "patch"
  });

  const prompt = buildPromptBody(
    {
      task: "Refresh the settings page",
      project_root: fixtureProjectRoot,
      files: ["src/pages/Settings.tsx"],
      constraints: [
        "audience: frontend developers",
        "approved facts: local repo access",
        "forbidden claims: privacy guarantees",
        "cta: Open a project in Codex"
      ],
      mode: "patch"
    },
    files
  );

  assert.match(prompt, /AUDIENCE:\n- frontend developers/);
  assert.match(prompt, /APPROVED_FACTS:\n- local repo access/);
  assert.match(prompt, /FORBIDDEN_CLAIMS:\n- privacy guarantees/);
  assert.match(prompt, /CTA_TEXT:\n- Open a project in Codex/);
});

test("systemPrompt requires grounded product copy", () => {
  assert.match(systemPrompt, /only trusted source of project facts/i);
  assert.match(systemPrompt, /Do not invent product capabilities/i);
  assert.match(systemPrompt, /When MODE is patch, prefer returning unified diffs/i);
  assert.match(systemPrompt, /first non-whitespace character.*\{/i);
  assert.match(systemPrompt, /Never return null/i);
});

test("stripJsonFence removes fenced json blocks", () => {
  const raw = "```json\n{\"summary\":\"ok\",\"response\":\"\",\"patches\":[],\"files\":{},\"notes\":[],\"warnings\":[]}\n```";
  assert.equal(
    stripJsonFence(raw),
    "{\"summary\":\"ok\",\"response\":\"\",\"patches\":[],\"files\":{},\"notes\":[],\"warnings\":[]}"
  );
});

test("stripJsonFence extracts embedded fenced json blocks", () => {
  const raw = "Here is the payload:\n```json\n{\"summary\":\"ok\"}\n```\nUse it carefully.";
  assert.equal(stripJsonFence(raw), "{\"summary\":\"ok\"}");
});

test("parseGeminiCliResponse parses the CLI envelope and inner JSON", () => {
  const stdout = JSON.stringify({
    response:
      "```json\n{\"summary\":\"done\",\"response\":\"advice\",\"patches\":[],\"files\":{\"src/pages/Settings.tsx\":\"export const x = 1;\"},\"notes\":[\"kept logic\"],\"warnings\":[]}\n```",
    stats: { tokens: 123 }
  });

  const parsed = parseGeminiCliResponse(stdout);
  assert.equal(parsed.summary, "done");
  assert.equal(parsed.response, "advice");
  assert.deepEqual(parsed.notes, ["kept logic"]);
});

test("parseGeminiCliResponse coerces simple JSON message payloads from live Gemini", () => {
  const stdout = JSON.stringify({
    response: "{\n  \"message\": \"The bridge has been confirmed to be working successfully.\"\n}"
  });

  const parsed = parseGeminiCliResponse(stdout);
  assert.equal(parsed.response, "The bridge has been confirmed to be working successfully.");
  assert.equal(parsed.patches.length, 0);
  assert.deepEqual(parsed.files, {});
  assert.match(parsed.warnings[0] ?? "", /outside the strict bridge schema/i);
});

test("parseGeminiCliResponse rejects invalid inner JSON", () => {
  const stdout = JSON.stringify({
    response: "```json\n{\"summary\": }\n```"
  });

  const parsed = parseGeminiCliResponse(stdout);
  assert.equal(parsed.response, "```json\n{\"summary\": }\n```");
  assert.match(parsed.warnings[0] ?? "", /plain text instead of the expected JSON payload/i);
});

test("parseGeminiCliResponse falls back to markdown file sections", () => {
  const stdout = JSON.stringify({
    response: [
      "Here are the full file contents to transform the page.",
      "",
      "### `src/index.html`",
      "```html",
      "<html></html>",
      "```",
      "",
      "### `styles/styles.css`",
      "```css",
      "body { color: black; }",
      "```"
    ].join("\n")
  });

  const parsed = parseGeminiCliResponse(stdout);
  assert.equal(parsed.files["src/index.html"], "<html></html>");
  assert.equal(parsed.files["styles/styles.css"], "body { color: black; }");
});

test("parseGeminiCliResponse falls back to a single fenced file with inline path comment", () => {
  const stdout = JSON.stringify({
    response: [
      "```tsx",
      "// src/pages/Settings.tsx",
      "export function Settings() {",
      "  return null;",
      "}",
      "```"
    ].join("\n")
  });

  const parsed = parseGeminiCliResponse(stdout);
  assert.equal(parsed.files["src/pages/Settings.tsx"], "export function Settings() {\n  return null;\n}");
});

test("parseGeminiCliResponse accepts fenced files with trailing commentary", () => {
  const stdout = JSON.stringify({
    response: [
      "```tsx",
      "// src/pages/Settings.tsx",
      "export function Settings() {",
      "  return null;",
      "}",
      "```",
      "",
      "Let me know if you want a second pass."
    ].join("\n")
  });

  const parsed = parseGeminiCliResponse(stdout);
  assert.equal(parsed.files["src/pages/Settings.tsx"], "export function Settings() {\n  return null;\n}");
});

test("parseGeminiCliResponse falls back to plain text responses", () => {
  const stdout = JSON.stringify({
    response: "Main risk: polling can take longer than the initial wait window."
  });

  const parsed = parseGeminiCliResponse(stdout);
  assert.equal(parsed.response, "Main risk: polling can take longer than the initial wait window.");
  assert.match(parsed.summary, /Main risk: polling can take longer/i);
  assert.match(parsed.warnings[0] ?? "", /plain text instead of the expected JSON payload/i);
});

test("resolveGeminiLaunch wraps Windows command scripts through cmd.exe", () => {
  const launch = resolveGeminiLaunch({
    command: "C:\\Users\\astoj\\AppData\\Roaming\\npm\\gemini.cmd",
    preArgs: ["--version"]
  });

  if (process.platform === "win32") {
    assert.match(launch.command, /cmd\.exe$/i);
    assert.deepEqual(launch.args, ["/d", "/s", "/c", "C:\\Users\\astoj\\AppData\\Roaming\\npm\\gemini.cmd", "--version"]);
    return;
  }

  assert.equal(launch.command, "C:\\Users\\astoj\\AppData\\Roaming\\npm\\gemini.cmd");
  assert.deepEqual(launch.args, ["--version"]);
});

test("validateResponseArtifacts maps a single fenced file without path to the requested file", () => {
  const parsed = parseGeminiCliResponse(
    JSON.stringify({
      response: [
        "Here is the updated component.",
        "",
        "```tsx",
        "export function Settings() {",
        "  return null;",
        "}",
        "```"
      ].join("\n")
    })
  );

  const validated = validateResponseArtifacts(["src/pages/Settings.tsx"], parsed);
  assert.equal(validated.files["src/pages/Settings.tsx"], "export function Settings() {\n  return null;\n}");
});

test("applyUnifiedDiff applies a simple unified diff", () => {
  const next = applyUnifiedDiff(
    ["export function Settings() {", "  return <div>Settings</div>;", "}"].join("\n"),
    ["@@ -1,3 +1,3 @@", " export function Settings() {", "-  return <div>Settings</div>;", "+  return <section>Settings</section>;", " }"].join("\n")
  );

  assert.equal(next, ["export function Settings() {", "  return <section>Settings</section>;", "}"].join("\n"));
});

test("applyUnifiedDiff rejects out-of-order hunks", () => {
  assert.throws(
    () =>
      applyUnifiedDiff(
        ["a", "b", "c", "d"].join("\n"),
        [
          "@@ -3,1 +3,1 @@",
          "-c",
          "+C",
          "@@ -1,1 +1,1 @@",
          "-a",
          "+A"
        ].join("\n")
      ),
    /overlap or are out of order/
  );
});

test("applyUnifiedDiff rejects mismatched hunk counts", () => {
  assert.throws(
    () =>
      applyUnifiedDiff(
        ["a", "b", "c"].join("\n"),
        [
          "@@ -1,2 +1,1 @@",
          " a",
          "-b",
          "+B",
          " c"
        ].join("\n")
      ),
    /hunk counts did not match header/
  );
});

test("createGeminiRunner enforces timeout", async () => {
  const runner = createGeminiRunner({
    command: "node",
    preArgs: [fakeGeminiScript],
    env: {
      ...process.env,
      FAKE_GEMINI_MODE: "timeout"
    },
    timeoutMs: 50
  });

  await assert.rejects(runner("header", "body"), /timed out/);
});

test("executeAskGemini returns a patch result from the fake Gemini CLI", async () => {
  const result = await executeAskGemini(
    {
      task: "Polish the settings page",
      project_root: fixtureProjectRoot,
      files: ["src/pages/Settings.tsx"],
      constraints: ["tailwind only", "keep business logic"],
      mode: "patch",
      apply: false
    },
    {
      geminiCli: {
        command: "node",
        preArgs: [fakeGeminiScript],
        env: {
          ...process.env,
          FAKE_GEMINI_MODE: "patch-success"
        }
      }
    }
  );

  assert.equal(result.summary, "Prepared a patch for the settings page.");
  assert.equal(result.patches.length, 1);
  assert.match(result.patches[0].unified_diff, /rounded-3xl/);
  assert.deepEqual(result.files, {});
  assert.equal(result.applied, false);
  assert.deepEqual(result.applied_files, []);
});

test("applyValidatedArtifacts writes a patch result to disk", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "gemini-ui-bridge-apply-"));
  const srcDir = path.join(tempRoot, "src", "pages");
  await mkdir(srcDir, { recursive: true });
  await writeFile(
    path.join(srcDir, "Settings.tsx"),
    ["export function Settings() {", "  return (", "    <div className=\"p-4\">Settings</div>", "  );", "}"].join("\n"),
    "utf8"
  );

  const appliedFiles = await applyValidatedArtifacts(
    tempRoot,
    [
      {
        path: "src/pages/Settings.tsx",
        unified_diff: [
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
    {}
  );

  const diskContent = await readFile(path.join(srcDir, "Settings.tsx"), "utf8");
  assert.match(diskContent, /rounded-3xl/);
  assert.deepEqual(appliedFiles, ["src/pages/Settings.tsx"]);
});

test("executeAskGemini applies patches when apply=true", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "gemini-ui-bridge-exec-apply-"));
  const srcDir = path.join(tempRoot, "src", "pages");
  await mkdir(srcDir, { recursive: true });
  await writeFile(
    path.join(srcDir, "Settings.tsx"),
    ["export function Settings() {", "  return (", "    <div className=\"p-4\">Settings</div>", "  );", "}"].join("\n"),
    "utf8"
  );

  const result = await executeAskGemini(
    {
      task: "Polish the settings page",
      project_root: tempRoot,
      files: ["src/pages/Settings.tsx"],
      mode: "patch",
      constraints: [],
      apply: true
    },
    {
      geminiCli: {
        command: "node",
        preArgs: [fakeGeminiScript],
        env: {
          ...process.env,
          FAKE_GEMINI_MODE: "patch-success"
        }
      }
    }
  );

  const diskContent = await readFile(path.join(srcDir, "Settings.tsx"), "utf8");
  assert.ok(diskContent.includes("rounded-3xl"));
  assert.equal(result.applied, true);
  assert.deepEqual(result.applied_files, ["src/pages/Settings.tsx"]);
});

test("executeAskGemini rejects apply=true when Gemini returns no edits", async () => {
  await assert.rejects(
    executeAskGemini(
      {
        task: "Polish the settings page",
        project_root: fixtureProjectRoot,
        files: ["src/pages/Settings.tsx"],
        mode: "patch",
        constraints: [],
        apply: true
      },
      {
        geminiCli: {
          command: "node",
          preArgs: [fakeGeminiScript],
          env: {
            ...process.env,
            FAKE_GEMINI_MODE: "consult-success"
          }
        }
      }
    ),
    /did not return any edits to apply/
  );
});

test("executeAskGemini rejects Gemini envelope errors", async () => {
  await assert.rejects(
    executeAskGemini(
      {
        task: "Polish the settings page",
        project_root: fixtureProjectRoot,
        files: ["src/pages/Settings.tsx"],
        mode: "patch",
        constraints: []
      },
      {
        geminiCli: {
          command: "node",
          preArgs: [fakeGeminiScript],
          env: {
            ...process.env,
            FAKE_GEMINI_MODE: "envelope-error"
          }
        }
      }
    ),
    /Gemini CLI returned an error/
  );
});

test("executeAskGemini falls back to a text response when Gemini returns invalid inner JSON", async () => {
  const result = await executeAskGemini(
    {
      task: "Polish the settings page",
      project_root: fixtureProjectRoot,
      files: ["src/pages/Settings.tsx"],
      mode: "patch",
      constraints: []
    },
    {
      geminiCli: {
        command: "node",
        preArgs: [fakeGeminiScript],
        env: {
          ...process.env,
          FAKE_GEMINI_MODE: "invalid-inner-json"
        }
      }
    }
  );

  assert.match(result.response, /summary/);
  assert.match(result.warnings[0] ?? "", /plain text instead of the expected JSON payload/i);
  assert.deepEqual(result.patches, []);
  assert.deepEqual(result.files, {});
});

test("executeAskGemini repairs a plain-text Gemini response into structured JSON", async () => {
  const result = await executeAskGemini(
    {
      task: "Review the settings page and return a structured response.",
      project_root: fixtureProjectRoot,
      files: ["src/pages/Settings.tsx"],
      mode: "review",
      constraints: []
    },
    {
      geminiCli: {
        command: "node",
        preArgs: [fakeGeminiScript],
        env: {
          ...process.env,
          FAKE_GEMINI_MODE: "plain-text-then-repair"
        }
      }
    }
  );

  assert.equal(result.summary, "Reformatted the original Gemini response into the broker schema.");
  assert.match(result.response, /no file changes are required/i);
  assert.match(result.notes.join(" "), /Repair pass completed/i);
  assert.match(result.notes.join(" "), /repair pass normalized/i);
  assert.ok(!result.warnings.includes("Gemini returned plain text instead of the expected JSON payload."));
});

test("executeAskGemini rejects unexpected files returned by Gemini", async () => {
  await assert.rejects(
    executeAskGemini(
      {
        task: "Polish the settings page",
        project_root: fixtureProjectRoot,
        files: ["src/pages/Settings.tsx"],
        mode: "patch",
        constraints: []
      },
      {
        geminiCli: {
          command: "node",
          preArgs: [fakeGeminiScript],
          env: {
            ...process.env,
            FAKE_GEMINI_MODE: "unexpected-file"
          }
        }
      }
    ),
    /unexpected file/
  );
});

test("executeAskGemini rejects unexpected patches returned by Gemini", async () => {
  await assert.rejects(
    executeAskGemini(
      {
        task: "Polish the settings page",
        project_root: fixtureProjectRoot,
        files: ["src/pages/Settings.tsx"],
        mode: "patch",
        constraints: []
      },
      {
        geminiCli: {
          command: "node",
          preArgs: [fakeGeminiScript],
          env: {
            ...process.env,
            FAKE_GEMINI_MODE: "unexpected-patch"
          }
        }
      }
    ),
    /unexpected patch target/
  );
});

test("executeAskGemini rejects oversized prompt context", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "gemini-ui-bridge-"));
  const srcDir = path.join(tempRoot, "src", "pages");
  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(srcDir, "Big.tsx"), "x".repeat(MAX_CONTEXT_CHARS), "utf8");

  await assert.rejects(
    executeAskGemini(
      {
        task: "Polish the huge page",
        project_root: tempRoot,
        files: ["src/pages/Big.tsx"],
        mode: "patch",
        constraints: []
      },
      {
        runner: async () => {
          throw new Error("runner should not be called");
        }
      }
    ),
    /Reduce the task\/constraints size or request fewer files/
  );
});

test("executeAskGemini launches Gemini in the target project_root and forwards a model override", async () => {
  const result = await executeAskGemini(
    {
      task: "Polish the settings page",
      project_root: fixtureProjectRoot,
      files: ["src/pages/Settings.tsx"],
      mode: "rewrite",
      constraints: []
    },
    {
      geminiCli: {
        command: "node",
        preArgs: [fakeGeminiScript],
        env: {
          ...process.env,
          FAKE_GEMINI_MODE: "assert-model-and-cwd",
          EXPECTED_CWD: fixtureProjectRoot
        },
        model: "gemini-3.1-pro-preview"
      }
    }
  );

  const observed = JSON.parse(result.files["src/pages/Settings.tsx"]);
  assert.equal(observed.cwd, fixtureProjectRoot);
  assert.equal(observed.model, "gemini-3.1-pro-preview");
  assert.deepEqual(result.notes, []);
});

test("createGeminiRunner uses the bridge default Gemini 3.1 model", async () => {
  const result = await executeAskGemini(
    {
      task: "Polish the settings page",
      project_root: fixtureProjectRoot,
      files: ["src/pages/Settings.tsx"],
      mode: "rewrite",
      constraints: []
    },
    {
      geminiCli: {
        command: "node",
        preArgs: [fakeGeminiScript],
        env: {
          ...process.env,
          FAKE_GEMINI_MODE: "assert-model-and-cwd",
          EXPECTED_CWD: fixtureProjectRoot,
          GEMINI_BRIDGE_MODEL: ""
        }
      }
    }
  );

  const observed = JSON.parse(result.files["src/pages/Settings.tsx"]);
  assert.equal(observed.model, "gemini-3.1-pro-preview");
});

test("prepareGeminiEnvironment creates an isolated profile with copied OAuth creds", async () => {
  const sourceHome = await mkdtemp(path.join(os.tmpdir(), "gemini-ui-bridge-source-home-"));
  const sourceGeminiDir = path.join(sourceHome, ".gemini");
  const profileHome = path.join(sourceHome, "bridge-home");
  await mkdir(sourceGeminiDir, { recursive: true });
  await writeFile(path.join(sourceGeminiDir, "oauth_creds.json"), "{\"token\":\"abc\"}", "utf8");

  const prepared = await prepareGeminiEnvironment({
    baseEnv: {
      ...process.env,
      GEMINI_BRIDGE_PROFILE_HOME: profileHome
    },
    model: "gemini-3.1-pro-preview",
    sourceHome
  });

  assert.equal(prepared.HOME, profileHome);
  assert.equal(prepared.USERPROFILE, profileHome);

  const copiedOauthCreds = await readFile(path.join(profileHome, ".gemini", "oauth_creds.json"), "utf8");
  const isolatedSettings = JSON.parse(await readFile(path.join(profileHome, ".gemini", "settings.json"), "utf8"));
  assert.equal(copiedOauthCreds, "{\"token\":\"abc\"}");
  assert.equal(isolatedSettings.security.auth.selectedType, "oauth-personal");
  assert.equal(isolatedSettings.extensions.enabled, false);
  assert.equal(isolatedSettings.skills.enabled, false);
  assert.equal(isolatedSettings.model.name, "gemini-3.1-pro-preview");
});

test("createGeminiRunner launches Gemini inside the isolated bridge profile", async () => {
  const sourceHome = await mkdtemp(path.join(os.tmpdir(), "gemini-ui-bridge-runner-home-"));
  const sourceGeminiDir = path.join(sourceHome, ".gemini");
  const profileHome = path.join(sourceHome, "bridge-home");
  await mkdir(sourceGeminiDir, { recursive: true });
  await writeFile(path.join(sourceGeminiDir, "oauth_creds.json"), "{\"token\":\"abc\"}", "utf8");

  const result = await executeAskGemini(
    {
      task: "Polish the settings page",
      project_root: fixtureProjectRoot,
      files: ["src/pages/Settings.tsx"],
      mode: "rewrite",
      constraints: []
    },
    {
      geminiCli: {
        command: "node",
        preArgs: [fakeGeminiScript],
        env: {
          ...process.env,
          FAKE_GEMINI_MODE: "assert-isolated-home",
          GEMINI_BRIDGE_SOURCE_HOME: sourceHome,
          GEMINI_BRIDGE_PROFILE_HOME: profileHome
        }
      }
    }
  );

  const observed = JSON.parse(result.files["src/pages/Settings.tsx"]);
  assert.equal(observed.home, profileHome);
  assert.equal(observed.userProfile, profileHome);
});

test("live Gemini smoke test is opt-in", { skip: process.env.LIVE_GEMINI_SMOKE !== "1" }, async () => {
  const result = await executeAskGemini({
    task: "Tighten spacing and improve card hierarchy.",
    project_root: fixtureProjectRoot,
    files: ["src/pages/Settings.tsx"],
    constraints: ["tailwind only", "keep business logic"],
    mode: "patch"
  });

  assert.ok(result.summary.length > 0);
});
