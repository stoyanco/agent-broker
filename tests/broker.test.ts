import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BROKER_HOME_ENV,
  clearBrokerStateForTests,
  cleanupExpiredConversations,
  deleteConversation,
  executeAskAgent,
  listAgents,
  listConversations,
  prepareAskAgentStartRequest
} from "../src/broker.js";

const fixtureProjectRoot = path.resolve("tests/fixtures/demo-project");
const fakeGeminiScript = path.resolve("tests/fixtures/fake-gemini.cjs");
const fakeClaudeScript = path.resolve("tests/fixtures/fake-claude.cjs");
const fakeCodexScript = path.resolve("tests/fixtures/fake-codex.cjs");
const brokerConfigPath = "config.json";

async function createCliWrapper(
  binaryName: string,
  scriptPath: string
): Promise<{ directory: string; wrapperPath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-broker-gemini-wrapper-"));
  const wrapperPath =
    process.platform === "win32" ? path.join(directory, `${binaryName}.cmd`) : path.join(directory, binaryName);

  const wrapperContent =
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`
      : `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`;

  await writeFile(wrapperPath, wrapperContent, "utf8");
  if (process.platform !== "win32") {
    await chmod(wrapperPath, 0o755);
  }

  return { directory, wrapperPath };
}

async function withBrokerEnv<T>(
  envOverrides: Record<string, string>,
  callback: (stateHome: string) => Promise<T>
): Promise<T> {
  const originalEnv: Record<string, string | undefined> = {
    GEMINI_BIN: process.env.GEMINI_BIN,
    CLAUDE_BIN: process.env.CLAUDE_BIN,
    CODEX_BIN: process.env.CODEX_BIN,
    FAKE_GEMINI_MODE: process.env.FAKE_GEMINI_MODE,
    FAKE_CLAUDE_MODE: process.env.FAKE_CLAUDE_MODE,
    FAKE_CODEX_MODE: process.env.FAKE_CODEX_MODE,
    [BROKER_HOME_ENV]: process.env[BROKER_HOME_ENV]
  };
  const geminiWrapper = await createCliWrapper("gemini", fakeGeminiScript);
  const claudeWrapper = await createCliWrapper("claude", fakeClaudeScript);
  const codexWrapper = await createCliWrapper("codex", fakeCodexScript);
  const stateHome = await mkdtemp(path.join(os.tmpdir(), "agent-broker-state-home-"));

  process.env.GEMINI_BIN = geminiWrapper.wrapperPath;
  process.env.CLAUDE_BIN = claudeWrapper.wrapperPath;
  process.env.CODEX_BIN = codexWrapper.wrapperPath;
  process.env[BROKER_HOME_ENV] = stateHome;
  for (const [key, value] of Object.entries(envOverrides)) {
    process.env[key] = value;
  }

  try {
    await clearBrokerStateForTests(stateHome);
    return await callback(stateHome);
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    await rm(geminiWrapper.directory, { recursive: true, force: true });
    await rm(claudeWrapper.directory, { recursive: true, force: true });
    await rm(codexWrapper.directory, { recursive: true, force: true });
    await rm(stateHome, { recursive: true, force: true });
  }
}

async function writeBrokerConfig(stateHome: string, config: unknown): Promise<void> {
  await writeFile(path.join(stateHome, brokerConfigPath), JSON.stringify(config, null, 2), "utf8");
}

test("listAgents reports the enabled Gemini, Claude, and Codex runtimes and capabilities", () => {
  const result = listAgents();
  assert.deepEqual(result.agents, [
    {
      agent: "gemini",
      enabled: true,
      default_model: "gemini-3.1-pro-preview",
      allowed_conversation_modes: ["stateless", "new", "continue"],
      allowed_modes: ["consult", "review", "patch", "rewrite"],
      allow_apply: true,
      require_apply_approval: false,
      max_files: 8,
      supports_model_override: true,
      supports_resume: true,
      supports_headless: true,
      supports_patch: true,
      supports_apply: true,
      supports_session_export: true
    },
    {
      agent: "claude",
      enabled: true,
      default_model: "sonnet",
      allowed_conversation_modes: ["stateless", "new", "continue"],
      allowed_modes: ["consult", "review"],
      allow_apply: false,
      require_apply_approval: false,
      max_files: 8,
      supports_model_override: true,
      supports_resume: true,
      supports_headless: true,
      supports_patch: false,
      supports_apply: false,
      supports_session_export: true
    },
    {
      agent: "codex",
      enabled: true,
      default_model: "gpt-5.4",
      allowed_conversation_modes: ["stateless", "new", "continue"],
      allowed_modes: ["consult", "review"],
      allow_apply: false,
      require_apply_approval: false,
      max_files: 8,
      supports_model_override: true,
      supports_resume: true,
      supports_headless: true,
      supports_patch: false,
      supports_apply: false,
      supports_session_export: true
    }
  ]);
});

test("prepareAskAgentStartRequest rejects stateless requests with a conversation_id", async () => {
  await assert.rejects(
    prepareAskAgentStartRequest({
      agent: "gemini",
      task: "Review this component structure.",
      project_root: fixtureProjectRoot,
      files: [],
      constraints: [],
      mode: "consult",
      apply: false,
      conversation_mode: "stateless",
      conversation_id: "ui-pass-1"
    }),
    /conversation_id is not allowed/
  );
});

test("executeAskAgent creates and resumes a persisted conversation", async () => {
  await withBrokerEnv(
    {
      FAKE_GEMINI_MODE: "session-success"
    },
    async () => {
      const started = await executeAskAgent({
        agent: "gemini",
        task: "Start a UI review thread.",
        project_root: fixtureProjectRoot,
        files: [],
        constraints: [],
        mode: "consult",
        apply: false,
        conversation_mode: "new"
      });

      assert.ok(started.conversation_id);
      assert.match(started.summary, /Started Gemini conversation/i);
      assert.match(started.response, /Call count: 1/);
      assert.match(started.notes[0] ?? "", /resume=none/);

      const continued = await executeAskAgent({
        agent: "gemini",
        task: "Continue the same UI thread.",
        project_root: fixtureProjectRoot,
        files: [],
        constraints: [],
        mode: "consult",
        apply: false,
        conversation_mode: "continue",
        conversation_id: started.conversation_id
      });

      assert.equal(continued.conversation_id, started.conversation_id);
      assert.match(continued.summary, /Resumed Gemini conversation/i);
      assert.match(continued.response, /Call count: 2/);
      assert.match(continued.notes[0] ?? "", /resume=latest/);
      assert.equal(continued.model, "gemini-3.1-pro-preview");
    }
  );
});

test("executeAskAgent rejects unknown conversations", async () => {
  await withBrokerEnv(
    {
      FAKE_GEMINI_MODE: "consult-success"
    },
    async () => {
      await assert.rejects(
        executeAskAgent({
          agent: "gemini",
          task: "Continue a missing thread.",
          project_root: fixtureProjectRoot,
          files: [],
          constraints: [],
          mode: "consult",
          apply: false,
          conversation_mode: "continue",
          conversation_id: "missing-thread"
        }),
        /No conversation found/
      );
    }
  );
});

test("executeAskAgent rejects a continue request that changes the stored model", async () => {
  await withBrokerEnv(
    {
      FAKE_GEMINI_MODE: "session-success"
    },
    async () => {
      const started = await executeAskAgent({
        agent: "gemini",
        task: "Start a UI review thread.",
        project_root: fixtureProjectRoot,
        files: [],
        constraints: [],
        mode: "consult",
        apply: false,
        conversation_mode: "new",
        model: "gemini-3.1-pro-preview"
      });

      await assert.rejects(
        executeAskAgent({
          agent: "gemini",
          task: "Continue with another model.",
          project_root: fixtureProjectRoot,
          files: [],
          constraints: [],
          mode: "consult",
          apply: false,
          conversation_mode: "continue",
          conversation_id: started.conversation_id,
          model: "gemini-2.5-flash"
        }),
        /pinned to model/
      );
    }
  );
});

test("executeAskAgent creates and resumes a Claude conversation", async () => {
  await withBrokerEnv(
    {
      FAKE_CLAUDE_MODE: "session-success"
    },
    async () => {
      const started = await executeAskAgent({
        agent: "claude",
        task: "Start a Claude review thread.",
        project_root: fixtureProjectRoot,
        files: [],
        constraints: [],
        mode: "consult",
        apply: false,
        conversation_mode: "new"
      });

      assert.ok(started.conversation_id);
      assert.match(started.summary, /Started Claude conversation/i);
      assert.match(started.response, /Call count: 1/);
      assert.match(started.notes[0] ?? "", /resume=none/);
      assert.match(started.notes[1] ?? "", /session_id=/);
      assert.equal(started.model, "sonnet");

      const continued = await executeAskAgent({
        agent: "claude",
        task: "Continue the same Claude thread.",
        project_root: fixtureProjectRoot,
        files: [],
        constraints: [],
        mode: "consult",
        apply: false,
        conversation_mode: "continue",
        conversation_id: started.conversation_id
      });

      assert.equal(continued.conversation_id, started.conversation_id);
      assert.match(continued.summary, /Resumed Claude conversation/i);
      assert.match(continued.response, /Call count: 2/);
      assert.match(continued.notes[0] ?? "", /resume=/);
    }
  );
});

test("executeAskAgent creates and resumes a Codex conversation", async () => {
  await withBrokerEnv(
    {
      FAKE_CODEX_MODE: "session-success"
    },
    async () => {
      const started = await executeAskAgent({
        agent: "codex",
        task: "Start a Codex review thread.",
        project_root: fixtureProjectRoot,
        files: [],
        constraints: [],
        mode: "consult",
        apply: false,
        conversation_mode: "new"
      });

      assert.ok(started.conversation_id);
      assert.match(started.summary, /Started Codex conversation/i);
      assert.match(started.response, /Call count: 1/);
      assert.match(started.notes[0] ?? "", /resume=none/);
      assert.match(started.notes[1] ?? "", /thread_id=/);
      assert.equal(started.model, "gpt-5.4");

      const continued = await executeAskAgent({
        agent: "codex",
        task: "Continue the same Codex thread.",
        project_root: fixtureProjectRoot,
        files: [],
        constraints: [],
        mode: "consult",
        apply: false,
        conversation_mode: "continue",
        conversation_id: started.conversation_id
      });

      assert.equal(continued.conversation_id, started.conversation_id);
      assert.match(continued.summary, /Resumed Codex conversation/i);
      assert.match(continued.response, /Call count: 2/);
      assert.match(continued.notes[0] ?? "", /resume=/);
    }
  );
});

test("executeAskAgent rejects unsupported Claude edit modes", async () => {
  await withBrokerEnv(
    {
      FAKE_CLAUDE_MODE: "consult-success"
    },
    async () => {
      await assert.rejects(
        executeAskAgent({
          agent: "claude",
          task: "Return a patch.",
          project_root: fixtureProjectRoot,
          files: ["src/pages/Settings.tsx"],
          constraints: [],
          mode: "patch",
          apply: false
        }),
        /does not support mode="patch"/
      );
    }
  );
});

test("executeAskAgent rejects unsupported Codex edit modes", async () => {
  await withBrokerEnv(
    {
      FAKE_CODEX_MODE: "consult-success"
    },
    async () => {
      await assert.rejects(
        executeAskAgent({
          agent: "codex",
          task: "Return a patch.",
          project_root: fixtureProjectRoot,
          files: ["src/pages/Settings.tsx"],
          constraints: [],
          mode: "patch",
          apply: false
        }),
        /does not support mode="patch"/
      );
    }
  );
});

test("listAgents reflects broker policy enabled flags and configured default models", async () => {
  await withBrokerEnv(
    {
      FAKE_GEMINI_MODE: "consult-success"
    },
    async (stateHome) => {
      await writeBrokerConfig(stateHome, {
        version: 1,
        agents: {
          gemini: {
            default_model: "gemini-2.5-flash",
            allowed_models: ["gemini-2.5-flash"],
            allowed_project_roots: [fixtureProjectRoot],
            allowed_conversation_modes: ["stateless"],
            allowed_modes: ["consult", "patch"],
            allow_apply: false,
            require_apply_approval: true,
            max_files: 3,
            max_task_chars: 120,
            max_constraints_chars: 40
          },
          claude: {
            enabled: false,
            default_model: "opus"
          },
          codex: {
            enabled: false,
            default_model: "gpt-5.3"
          }
        }
      });

      const result = listAgents();
      assert.deepEqual(result.agents, [
        {
          agent: "gemini",
          enabled: true,
          default_model: "gemini-2.5-flash",
          allowed_models: ["gemini-2.5-flash"],
          allowed_project_roots: [fixtureProjectRoot],
          allowed_conversation_modes: ["stateless"],
          allowed_modes: ["consult", "patch"],
          allow_apply: false,
          require_apply_approval: true,
          max_files: 3,
          max_task_chars: 120,
          max_constraints_chars: 40,
          supports_model_override: true,
          supports_resume: true,
          supports_headless: true,
          supports_patch: true,
          supports_apply: true,
          supports_session_export: true
        },
        {
          agent: "claude",
          enabled: false,
          default_model: "opus",
          allowed_conversation_modes: ["stateless", "new", "continue"],
          allowed_modes: ["consult", "review"],
          allow_apply: false,
          require_apply_approval: false,
          max_files: 8,
          supports_model_override: true,
          supports_resume: true,
          supports_headless: true,
          supports_patch: false,
          supports_apply: false,
          supports_session_export: true
        },
        {
          agent: "codex",
          enabled: false,
          default_model: "gpt-5.3",
          allowed_conversation_modes: ["stateless", "new", "continue"],
          allowed_modes: ["consult", "review"],
          allow_apply: false,
          require_apply_approval: false,
          max_files: 8,
          supports_model_override: true,
          supports_resume: true,
          supports_headless: true,
          supports_patch: false,
          supports_apply: false,
          supports_session_export: true
        }
      ]);
    }
  );
});

test("executeAskAgent uses the broker policy default model when one is configured", async () => {
  await withBrokerEnv(
    {
      FAKE_GEMINI_MODE: "assert-model-and-cwd",
      EXPECTED_CWD: fixtureProjectRoot
    },
    async (stateHome) => {
      await writeBrokerConfig(stateHome, {
        version: 1,
        agents: {
          gemini: {
            default_model: "gemini-2.5-flash"
          }
        }
      });

      const result = await executeAskAgent({
        agent: "gemini",
        task: "Inspect the selected model.",
        project_root: fixtureProjectRoot,
        files: ["src/pages/Settings.tsx"],
        constraints: [],
        mode: "patch",
        apply: false
      });

      assert.equal(result.model, "gemini-2.5-flash");
      assert.equal(
        JSON.parse(result.files["src/pages/Settings.tsx"] ?? "{}").model,
        "gemini-2.5-flash"
      );
    }
  );
});

test("executeAskAgent rejects model overrides outside the broker allowed_models policy", async () => {
  await withBrokerEnv(
    {
      FAKE_GEMINI_MODE: "consult-success"
    },
    async (stateHome) => {
      await writeBrokerConfig(stateHome, {
        version: 1,
        agents: {
          gemini: {
            allowed_models: ["gemini-2.5-flash"]
          }
        }
      });

      await assert.rejects(
        executeAskAgent({
          agent: "gemini",
          model: "gemini-3.1-pro-preview",
          task: "Use a disallowed model.",
          project_root: fixtureProjectRoot,
          files: [],
          constraints: [],
          mode: "consult",
          apply: false
        }),
        /only allows configured models/
      );
    }
  );
});

test("executeAskAgent accepts configured allowed_models and forwards the selected model", async () => {
  await withBrokerEnv(
    {
      FAKE_CLAUDE_MODE: "assert-model"
    },
    async (stateHome) => {
      await writeBrokerConfig(stateHome, {
        version: 1,
        agents: {
          claude: {
            allowed_models: ["sonnet"]
          }
        }
      });

      const result = await executeAskAgent({
        agent: "claude",
        model: "sonnet",
        task: "Inspect the selected Claude model.",
        project_root: fixtureProjectRoot,
        files: [],
        constraints: [],
        mode: "consult",
        apply: false
      });

      assert.equal(result.model, "sonnet");
      assert.equal(JSON.parse(result.files["src/pages/Settings.tsx"] ?? "{}").model, "sonnet");
    }
  );
});

test("executeAskAgent accepts configured Codex allowed_models and forwards the selected model", async () => {
  await withBrokerEnv(
    {
      FAKE_CODEX_MODE: "assert-model-and-cwd"
    },
    async (stateHome) => {
      await writeBrokerConfig(stateHome, {
        version: 1,
        agents: {
          codex: {
            allowed_models: ["gpt-5.4"]
          }
        }
      });

      const result = await executeAskAgent({
        agent: "codex",
        model: "gpt-5.4",
        task: "Inspect the selected Codex model.",
        project_root: fixtureProjectRoot,
        files: ["src/pages/Settings.tsx"],
        constraints: [],
        mode: "consult",
        apply: false
      });

      assert.equal(result.model, "gpt-5.4");
      assert.equal(JSON.parse(result.files["src/pages/Settings.tsx"] ?? "{}").model, "gpt-5.4");
      assert.equal(JSON.parse(result.files["src/pages/Settings.tsx"] ?? "{}").cwd, fixtureProjectRoot);
    }
  );
});

test("executeAskAgent rejects conversation modes disallowed by broker policy", async () => {
  await withBrokerEnv(
    {
      FAKE_GEMINI_MODE: "session-success"
    },
    async (stateHome) => {
      await writeBrokerConfig(stateHome, {
        version: 1,
        agents: {
          gemini: {
            allowed_conversation_modes: ["stateless"]
          }
        }
      });

      await assert.rejects(
        executeAskAgent({
          agent: "gemini",
          task: "Start a blocked resumable thread.",
          project_root: fixtureProjectRoot,
          files: [],
          constraints: [],
          mode: "consult",
          apply: false,
          conversation_mode: "new"
        }),
        /does not allow conversation_mode="new"/
      );
    }
  );
});

test("executeAskAgent rejects project roots outside broker allowed_project_roots", async () => {
  await withBrokerEnv(
    {
      FAKE_GEMINI_MODE: "consult-success"
    },
    async (stateHome) => {
      await writeBrokerConfig(stateHome, {
        version: 1,
        agents: {
          gemini: {
            allowed_project_roots: [path.resolve("tests/fixtures")]
          }
        }
      });

      await assert.rejects(
        executeAskAgent({
          agent: "gemini",
          task: "Review this repo root request.",
          project_root: path.resolve("."),
          files: [],
          constraints: [],
          mode: "consult",
          apply: false
        }),
        /restricted to configured project roots/
      );
    }
  );
});

test("executeAskAgent accepts project roots within broker allowed_project_roots", async () => {
  await withBrokerEnv(
    {
      FAKE_GEMINI_MODE: "consult-success"
    },
    async (stateHome) => {
      await writeBrokerConfig(stateHome, {
        version: 1,
        agents: {
          gemini: {
            allowed_project_roots: [path.resolve("tests/fixtures")]
          }
        }
      });

      const result = await executeAskAgent({
        agent: "gemini",
        task: "Review this allowed project root request.",
        project_root: fixtureProjectRoot,
        files: [],
        constraints: [],
        mode: "consult",
        apply: false
      });

      assert.equal(result.agent, "gemini");
      assert.match(result.summary, /implementation advice/i);
    }
  );
});

test("executeAskAgent rejects requests that exceed broker max_files", async () => {
  await withBrokerEnv(
    {
      FAKE_GEMINI_MODE: "consult-success"
    },
    async (stateHome) => {
      await writeBrokerConfig(stateHome, {
        version: 1,
        agents: {
          gemini: {
            max_files: 1
          }
        }
      });

      await assert.rejects(
        executeAskAgent({
          agent: "gemini",
          task: "Review these two files.",
          project_root: fixtureProjectRoot,
          files: ["src/pages/Settings.tsx", "src/components/Button.tsx"],
          constraints: [],
          mode: "review",
          apply: false
        }),
        /allows at most 1 file/
      );
    }
  );
});

test("executeAskAgent rejects requests that exceed broker max_task_chars", async () => {
  await withBrokerEnv(
    {
      FAKE_GEMINI_MODE: "consult-success"
    },
    async (stateHome) => {
      await writeBrokerConfig(stateHome, {
        version: 1,
        agents: {
          gemini: {
            max_task_chars: 12
          }
        }
      });

      await assert.rejects(
        executeAskAgent({
          agent: "gemini",
          task: "This task is definitely too long.",
          project_root: fixtureProjectRoot,
          files: [],
          constraints: [],
          mode: "consult",
          apply: false
        }),
        /allows at most 12 task characters/
      );
    }
  );
});

test("executeAskAgent rejects requests that exceed broker max_constraints_chars", async () => {
  await withBrokerEnv(
    {
      FAKE_GEMINI_MODE: "consult-success"
    },
    async (stateHome) => {
      await writeBrokerConfig(stateHome, {
        version: 1,
        agents: {
          gemini: {
            max_constraints_chars: 10
          }
        }
      });

      await assert.rejects(
        executeAskAgent({
          agent: "gemini",
          task: "Review this request.",
          project_root: fixtureProjectRoot,
          files: [],
          constraints: ["tone: concise", "preserve: headings"],
          mode: "consult",
          apply: false
        }),
        /allows at most 10 total constraint characters/
      );
    }
  );
});

test("executeAskAgent rejects disabled agents from broker policy", async () => {
  await withBrokerEnv(
    {
      FAKE_CLAUDE_MODE: "consult-success"
    },
    async (stateHome) => {
      await writeBrokerConfig(stateHome, {
        version: 1,
        agents: {
          claude: {
            enabled: false
          }
        }
      });

      await assert.rejects(
        executeAskAgent({
          agent: "claude",
          task: "Review this broker change.",
          project_root: fixtureProjectRoot,
          files: [],
          constraints: [],
          mode: "consult",
          apply: false
        }),
        /disabled by broker policy/
      );
    }
  );
});

test("executeAskAgent rejects modes disallowed by broker policy", async () => {
  await withBrokerEnv(
    {
      FAKE_GEMINI_MODE: "consult-success"
    },
    async (stateHome) => {
      await writeBrokerConfig(stateHome, {
        version: 1,
        agents: {
          gemini: {
            allowed_modes: ["consult"]
          }
        }
      });

      await assert.rejects(
        executeAskAgent({
          agent: "gemini",
          task: "Review this broker change.",
          project_root: fixtureProjectRoot,
          files: [],
          constraints: [],
          mode: "review",
          apply: false
        }),
        /disabled for mode="review" by broker policy/
      );
    }
  );
});

test("executeAskAgent rejects apply requests disallowed by broker policy", async () => {
  await withBrokerEnv(
    {
      FAKE_GEMINI_MODE: "consult-success"
    },
    async (stateHome) => {
      await writeBrokerConfig(stateHome, {
        version: 1,
        agents: {
          gemini: {
            allow_apply: false
          }
        }
      });

      await assert.rejects(
        executeAskAgent({
          agent: "gemini",
          task: "Return and apply a patch.",
          project_root: fixtureProjectRoot,
          files: ["src/pages/Settings.tsx"],
          constraints: [],
          mode: "patch",
          apply: true
        }),
        /disabled for apply=true by broker policy/
      );
    }
  );
});

test("executeAskAgent requires explicit apply approval when broker policy enables it", async () => {
  await withBrokerEnv(
    {
      FAKE_GEMINI_MODE: "rewrite-success"
    },
    async (stateHome) => {
      await writeBrokerConfig(stateHome, {
        version: 1,
        agents: {
          gemini: {
            allow_apply: true,
            require_apply_approval: true
          }
        }
      });

      await assert.rejects(
        executeAskAgent({
          agent: "gemini",
          task: "Return and apply a patch.",
          project_root: fixtureProjectRoot,
          files: ["src/pages/Settings.tsx"],
          constraints: [],
          mode: "patch",
          apply: true,
          apply_approved: false
        }),
        /requires apply_approved=true/
      );

      const result = await executeAskAgent({
        agent: "gemini",
        task: "Return and apply a rewrite.",
        project_root: fixtureProjectRoot,
        files: ["src/pages/Settings.tsx"],
        constraints: [],
        mode: "rewrite",
        apply: true,
        apply_approved: true
      });

      assert.equal(result.applied, true);
    }
  );
});

test("listConversations returns resumable sessions and deleteConversation removes them", async () => {
  await withBrokerEnv(
    {
      FAKE_GEMINI_MODE: "session-success"
    },
    async () => {
      const started = await executeAskAgent({
        agent: "gemini",
        task: "Start a tracked UI thread.",
        project_root: fixtureProjectRoot,
        files: [],
        constraints: [],
        mode: "consult",
        apply: false,
        conversation_mode: "new"
      });

      assert.ok(started.conversation_id);

      const listed = await listConversations();
      assert.deepEqual(
        listed.conversations.map((conversation) => ({
          conversation_id: conversation.conversation_id,
          agent: conversation.agent,
          project_root: conversation.project_root,
          model: conversation.model
        })),
        [
          {
            conversation_id: started.conversation_id,
            agent: "gemini",
            project_root: fixtureProjectRoot,
            model: "gemini-3.1-pro-preview"
          }
        ]
      );

      const deleted = await deleteConversation({
        conversation_id: started.conversation_id
      });
      assert.deepEqual(deleted, {
        conversation_id: started.conversation_id,
        deleted: true,
        removed_profile: true
      });

      const listedAfterDelete = await listConversations();
      assert.deepEqual(listedAfterDelete.conversations, []);

      await assert.rejects(
        executeAskAgent({
          agent: "gemini",
          task: "Continue a deleted thread.",
          project_root: fixtureProjectRoot,
          files: [],
          constraints: [],
          mode: "consult",
          apply: false,
          conversation_mode: "continue",
          conversation_id: started.conversation_id
        }),
        /No conversation found/
      );
    }
  );
});

test("deleteConversation returns deleted=false for unknown conversation ids", async () => {
  await withBrokerEnv(
    {
      FAKE_GEMINI_MODE: "consult-success"
    },
    async () => {
      const deleted = await deleteConversation({
        conversation_id: "missing-thread"
      });

      assert.deepEqual(deleted, {
        conversation_id: "missing-thread",
        deleted: false,
        removed_profile: false
      });
    }
  );
});

test("conversation retention policy prunes expired sessions and blocks resume", async () => {
  await withBrokerEnv(
    {
      FAKE_GEMINI_MODE: "session-success"
    },
    async (stateHome) => {
      await writeBrokerConfig(stateHome, {
        version: 1,
        conversations: {
          max_age_hours: 1
        }
      });

      const started = await executeAskAgent(
        {
          agent: "gemini",
          task: "Start an expiring thread.",
          project_root: fixtureProjectRoot,
          files: [],
          constraints: [],
          mode: "consult",
          apply: false,
          conversation_mode: "new"
        },
        {
          stateHome,
          now: new Date("2026-03-14T08:00:00.000Z")
        }
      );

      assert.ok(started.conversation_id);

      const cleanupResult = await cleanupExpiredConversations(stateHome, new Date("2026-03-14T10:30:00.000Z"));
      assert.deepEqual(cleanupResult, {
        deleted: 1,
        removed_profiles: 1
      });

      const listed = await listConversations(stateHome);
      assert.deepEqual(listed.conversations, []);

      await assert.rejects(
        executeAskAgent(
          {
            agent: "gemini",
            task: "Continue an expired thread.",
            project_root: fixtureProjectRoot,
            files: [],
            constraints: [],
            mode: "consult",
            apply: false,
            conversation_mode: "continue",
            conversation_id: started.conversation_id
          },
          {
            stateHome,
            now: new Date("2026-03-14T10:30:00.000Z")
          }
        ),
        /No conversation found/
      );
    }
  );
});
