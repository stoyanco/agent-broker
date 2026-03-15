import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const workspaceRoot = path.resolve(".");
const distCliPath = path.join(workspaceRoot, "dist", "cli.js");
const fakeGeminiScript = path.resolve("tests/fixtures/fake-gemini.cjs");
const fakeClaudeScript = path.resolve("tests/fixtures/fake-claude.cjs");
const fakeCodexScript = path.resolve("tests/fixtures/fake-codex.cjs");
let builtCliReady: Promise<void> | null = null;

type E2EConnection = {
  client: Client;
  close: () => Promise<void>;
};

type AskAgentToolOutput = {
  agent: string;
  model: string;
  status: "running" | "completed";
  summary: string;
  response: string;
  job_id: string;
  conversation_id?: string;
  notes: string[];
  warnings: string[];
  applied: boolean;
  applied_files: string[];
};

function createStringEnv(overrides: Record<string, string>): Record<string, string> {
  const entries = Object.entries({
    ...process.env,
    ...overrides
  }).filter((entry): entry is [string, string] => typeof entry[1] === "string");

  return Object.fromEntries(entries);
}

async function ensureBuiltCli(): Promise<void> {
  if (!builtCliReady) {
    builtCliReady = (async () => {
      execFileSync(process.execPath, ["./node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"], {
        cwd: workspaceRoot,
        stdio: "inherit"
      });

      await access(distCliPath);
    })();
  }

  await builtCliReady;
}

async function createCliWrapper(
  binaryName: string,
  scriptPath: string
): Promise<{ directory: string; wrapperPath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), `agent-broker-${binaryName}-wrapper-`));
  const stateHome = path.join(directory, "broker-home");
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

  void stateHome;
  return { directory, wrapperPath };
}

async function connectE2E(
  envOverrides: Record<string, string>,
  clientName: string
): Promise<E2EConnection> {
  await ensureBuiltCli();
  const geminiWrapper = await createCliWrapper("gemini", fakeGeminiScript);
  const claudeWrapper = await createCliWrapper("claude", fakeClaudeScript);
  const codexWrapper = await createCliWrapper("codex", fakeCodexScript);
  const stateHome = path.join(geminiWrapper.directory, "broker-home");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distCliPath],
    cwd: workspaceRoot,
    env: createStringEnv({
      GEMINI_BIN: geminiWrapper.wrapperPath,
      CLAUDE_BIN: claudeWrapper.wrapperPath,
      CODEX_BIN: codexWrapper.wrapperPath,
      AGENT_BROKER_HOME: stateHome,
      ...envOverrides
    }),
    stderr: "pipe"
  });
  const client = new Client({
    name: clientName,
    version: "1.0.0"
  });

  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close().catch(() => undefined);
    await rm(geminiWrapper.directory, { recursive: true, force: true });
    await rm(claudeWrapper.directory, { recursive: true, force: true });
    await rm(codexWrapper.directory, { recursive: true, force: true });
    throw error;
  }

  return {
    client,
    close: async () => {
      await transport.close().catch(() => undefined);
      await rm(geminiWrapper.directory, { recursive: true, force: true });
      await rm(claudeWrapper.directory, { recursive: true, force: true });
      await rm(codexWrapper.directory, { recursive: true, force: true });
    }
  };
}

function getAskAgentOutput(result: unknown): AskAgentToolOutput {
  return (result as { structuredContent?: unknown }).structuredContent as AskAgentToolOutput;
}

function getTextContent(result: unknown): string {
  return (result as { content?: Array<{ type?: string; text?: string }> }).content?.find((item) => item.type === "text")?.text ?? "";
}

test("MCP stdio server lists the generic tools and handles a completed ask_agent call", async () => {
  const connection = await connectE2E(
    {
      FAKE_GEMINI_MODE: "consult-success"
    },
    "mcp-e2e-complete"
  );

  try {
    const tools = await connection.client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, ["ask_agent", "delete_conversation", "list_agents", "list_conversations"]);

    const listAgentsResult = await connection.client.callTool({
      name: "list_agents",
      arguments: {}
    });
    const listedAgents = (
      listAgentsResult.structuredContent as {
        agents: Array<{
          agent: string;
          allowed_models?: string[];
          allowed_project_roots?: string[];
          allowed_conversation_modes: string[];
          allowed_modes: string[];
          allow_apply: boolean;
          require_apply_approval: boolean;
          max_files: number;
          max_constraints_chars?: number;
          timeout_ms?: number;
          max_poll_attempts?: number;
        }>;
      }
    ).agents;
    const geminiAgent = listedAgents.find((agent) => agent.agent === "gemini");
    const claudeAgent = listedAgents.find((agent) => agent.agent === "claude");
    const codexAgent = listedAgents.find((agent) => agent.agent === "codex");
    assert.ok(geminiAgent);
    assert.ok(claudeAgent);
    assert.ok(codexAgent);
    assert.equal(geminiAgent.allowed_models, undefined);
    assert.equal(geminiAgent.allowed_project_roots, undefined);
    assert.deepEqual(geminiAgent.allowed_conversation_modes, ["stateless", "new", "continue"]);
    assert.deepEqual(geminiAgent.allowed_modes, ["consult", "review", "patch", "rewrite"]);
    assert.equal(geminiAgent.allow_apply, true);
    assert.equal(geminiAgent.require_apply_approval, false);
    assert.equal(geminiAgent.max_files, 8);
    assert.equal(geminiAgent.max_constraints_chars, undefined);
    assert.equal(geminiAgent.timeout_ms, undefined);
    assert.equal(geminiAgent.max_poll_attempts, undefined);
    assert.equal(claudeAgent.allowed_models, undefined);
    assert.equal(claudeAgent.allowed_project_roots, undefined);
    assert.deepEqual(claudeAgent.allowed_conversation_modes, ["stateless", "new", "continue"]);
    assert.deepEqual(claudeAgent.allowed_modes, ["consult", "review"]);
    assert.equal(claudeAgent.allow_apply, false);
    assert.equal(claudeAgent.require_apply_approval, false);
    assert.equal(claudeAgent.max_files, 8);
    assert.equal(claudeAgent.max_constraints_chars, undefined);
    assert.equal(claudeAgent.timeout_ms, undefined);
    assert.equal(claudeAgent.max_poll_attempts, undefined);
    assert.equal(codexAgent.allowed_models, undefined);
    assert.equal(codexAgent.allowed_project_roots, undefined);
    assert.deepEqual(codexAgent.allowed_conversation_modes, ["stateless", "new", "continue"]);
    assert.deepEqual(codexAgent.allowed_modes, ["consult", "review"]);
    assert.equal(codexAgent.allow_apply, false);
    assert.equal(codexAgent.require_apply_approval, false);
    assert.equal(codexAgent.max_files, 8);
    assert.equal(codexAgent.max_constraints_chars, undefined);
    assert.equal(codexAgent.timeout_ms, undefined);
    assert.equal(codexAgent.max_poll_attempts, undefined);

    const result = await connection.client.callTool({
      name: "ask_agent",
      arguments: {
        agent: "gemini",
        task: "Share one concrete implementation suggestion.",
        project_root: workspaceRoot,
        files: [],
        constraints: ["tone: concise"],
        mode: "consult",
        apply: false
      }
    });
    const output = getAskAgentOutput(result);

    assert.notEqual(result.isError, true);
    assert.equal(output.status, "completed");
    assert.equal(output.agent, "gemini");
    assert.equal(output.summary, "Shared implementation advice.");
    assert.match(output.response, /patch-first/i);
  } finally {
    await connection.close();
  }
});

test("MCP stdio server handles a completed Claude ask_agent call", async () => {
  const connection = await connectE2E(
    {
      FAKE_CLAUDE_MODE: "consult-success"
    },
    "mcp-e2e-claude-complete"
  );

  try {
    const result = await connection.client.callTool({
      name: "ask_agent",
      arguments: {
        agent: "claude",
        task: "Share one concrete implementation suggestion.",
        project_root: workspaceRoot,
        files: [],
        constraints: ["tone: concise"],
        mode: "consult",
        apply: false
      }
    });
    const output = getAskAgentOutput(result);

    assert.notEqual(result.isError, true);
    assert.equal(output.status, "completed");
    assert.equal(output.agent, "claude");
    assert.equal(output.summary, "Shared Claude implementation advice.");
    assert.match(output.response, /thin broker core/i);
  } finally {
    await connection.close();
  }
});

test("MCP stdio server handles a completed Codex ask_agent call", async () => {
  const connection = await connectE2E(
    {
      FAKE_CODEX_MODE: "consult-success"
    },
    "mcp-e2e-codex-complete"
  );

  try {
    const result = await connection.client.callTool({
      name: "ask_agent",
      arguments: {
        agent: "codex",
        task: "Share one concrete implementation suggestion.",
        project_root: workspaceRoot,
        files: [],
        constraints: ["tone: concise"],
        mode: "consult",
        apply: false
      }
    });
    const output = getAskAgentOutput(result);

    assert.notEqual(result.isError, true);
    assert.equal(output.status, "completed");
    assert.equal(output.agent, "codex");
    assert.equal(output.summary, "Shared Codex implementation advice.");
    assert.match(output.response, /policy discovery/i);
  } finally {
    await connection.close();
  }
});

test("MCP stdio server supports ask_agent polling with a job_id", async () => {
  const connection = await connectE2E(
    {
      FAKE_GEMINI_MODE: "delayed-consult-success",
      AGENT_BROKER_INITIAL_WAIT_MS: "1",
      AGENT_BROKER_POLL_WAIT_MS: "250"
    },
    "mcp-e2e-polling"
  );

  try {
    const firstResult = await connection.client.callTool({
      name: "ask_agent",
      arguments: {
        agent: "gemini",
        task: "Complete after a short delay.",
        project_root: workspaceRoot,
        files: [],
        constraints: [],
        mode: "consult",
        apply: false
      }
    });
    const firstOutput = getAskAgentOutput(firstResult);

    assert.notEqual(firstResult.isError, true);
    assert.equal(firstOutput.status, "running");
    assert.match(firstOutput.job_id, /^[0-9a-f]{16}$/);

    let finalOutput: AskAgentToolOutput | null = null;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const pollResult = await connection.client.callTool({
        name: "ask_agent",
        arguments: {
          job_id: firstOutput.job_id
        }
      });
      const pollOutput = getAskAgentOutput(pollResult);

      assert.notEqual(pollResult.isError, true);
      if (pollOutput.status === "completed") {
        finalOutput = pollOutput;
        break;
      }
    }

    assert.ok(finalOutput, "expected ask_agent polling to complete within 4 attempts");
    assert.equal(finalOutput.status, "completed");
    assert.match(finalOutput.response, /delayed Gemini response/i);
    assert.equal(finalOutput.job_id, firstOutput.job_id);
  } finally {
    await connection.close();
  }
});

test("MCP stdio server persists and resumes conversations through ask_agent", async () => {
  const connection = await connectE2E(
    {
      FAKE_GEMINI_MODE: "session-success"
    },
    "mcp-e2e-conversations"
  );

  try {
    const started = await connection.client.callTool({
      name: "ask_agent",
      arguments: {
        agent: "gemini",
        task: "Start a UI thread.",
        project_root: workspaceRoot,
        files: [],
        constraints: [],
        mode: "consult",
        apply: false,
        conversation_mode: "new"
      }
    });
    const startedOutput = getAskAgentOutput(started);

    assert.equal(startedOutput.status, "completed");
    assert.ok(startedOutput.conversation_id);
    assert.match(startedOutput.response, /Call count: 1/);

    const continued = await connection.client.callTool({
      name: "ask_agent",
      arguments: {
        agent: "gemini",
        task: "Continue the UI thread.",
        project_root: workspaceRoot,
        files: [],
        constraints: [],
        mode: "consult",
        apply: false,
        conversation_mode: "continue",
        conversation_id: startedOutput.conversation_id
      }
    });
    const continuedOutput = getAskAgentOutput(continued);

    assert.equal(continuedOutput.status, "completed");
    assert.equal(continuedOutput.conversation_id, startedOutput.conversation_id);
    assert.match(continuedOutput.response, /Call count: 2/);
    assert.match(continuedOutput.notes[0] ?? "", /resume=latest/);
  } finally {
    await connection.close();
  }
});

test("MCP stdio server lists and deletes broker conversations", async () => {
  const connection = await connectE2E(
    {
      FAKE_GEMINI_MODE: "session-success"
    },
    "mcp-e2e-conversation-tools"
  );

  try {
    const started = await connection.client.callTool({
      name: "ask_agent",
      arguments: {
        agent: "gemini",
        task: "Start a tracked broker conversation.",
        project_root: workspaceRoot,
        files: [],
        constraints: [],
        mode: "consult",
        apply: false,
        conversation_mode: "new"
      }
    });
    const startedOutput = getAskAgentOutput(started);

    assert.equal(startedOutput.status, "completed");
    assert.ok(startedOutput.conversation_id);

    const listed = await connection.client.callTool({
      name: "list_conversations",
      arguments: {}
    });
    const conversations = (
      listed.structuredContent as {
        conversations: Array<{ conversation_id: string; agent: string; model: string }>;
      }
    ).conversations;
    assert.ok(conversations.some((conversation) => conversation.conversation_id === startedOutput.conversation_id));

    const deleted = await connection.client.callTool({
      name: "delete_conversation",
      arguments: {
        conversation_id: startedOutput.conversation_id
      }
    });
    const deletedOutput = deleted.structuredContent as {
      conversation_id: string;
      deleted: boolean;
      removed_profile: boolean;
    };

    assert.notEqual(deleted.isError, true);
    assert.deepEqual(deletedOutput, {
      conversation_id: startedOutput.conversation_id,
      deleted: true,
      removed_profile: true
    });

    const listedAfterDelete = await connection.client.callTool({
      name: "list_conversations",
      arguments: {}
    });
    const conversationsAfterDelete = (
      listedAfterDelete.structuredContent as {
        conversations: Array<{ conversation_id: string }>;
      }
    ).conversations;
    assert.ok(!conversationsAfterDelete.some((conversation) => conversation.conversation_id === startedOutput.conversation_id));
  } finally {
    await connection.close();
  }
});

test("MCP stdio server surfaces provider failures without crashing", async (t) => {
  const failureCases: Array<{ name: string; mode: string; timeoutMs?: string; messagePattern: RegExp }> = [
    {
      name: "malformed provider envelope",
      mode: "invalid-envelope",
      messagePattern: /did not return valid JSON/i
    },
    {
      name: "provider process error",
      mode: "process-error",
      messagePattern: /exited with code 3/i
    },
    {
      name: "provider timeout",
      mode: "timeout",
      timeoutMs: "25",
      messagePattern: /timed out/i
    }
  ];

  for (const failureCase of failureCases) {
    await t.test(failureCase.name, async () => {
      const connection = await connectE2E(
        {
          FAKE_GEMINI_MODE: failureCase.mode,
          ...(failureCase.timeoutMs ? { GEMINI_BRIDGE_TIMEOUT_MS: failureCase.timeoutMs } : {})
        },
        `mcp-e2e-${failureCase.mode}`
      );

      try {
        const result = await connection.client.callTool({
          name: "ask_agent",
          arguments: {
            agent: "gemini",
            task: "Exercise an error path.",
            project_root: workspaceRoot,
            files: [],
            constraints: [],
            mode: "consult",
            apply: false
          }
        });

        assert.equal(result.isError, true);
        assert.match(getTextContent(result), failureCase.messagePattern);

        const tools = await connection.client.listTools();
        assert.ok(tools.tools.some((tool) => tool.name === "ask_agent"));
      } finally {
        await connection.close();
      }
    });
  }
});

test("MCP stdio server rejects unknown polling job ids without crashing", async () => {
  const connection = await connectE2E(
    {
      FAKE_GEMINI_MODE: "consult-success"
    },
    "mcp-e2e-missing-job"
  );

  try {
    const result = await connection.client.callTool({
      name: "ask_agent",
      arguments: {
        job_id: "deadbeefdeadbeef"
      }
    });

    assert.equal(result.isError, true);
    assert.match(getTextContent(result), /No running agent job found/i);

    const tools = await connection.client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "list_agents"));
  } finally {
    await connection.close();
  }
});

test("MCP stdio server rejects patch mode without files through tool validation", async () => {
  const connection = await connectE2E(
    {
      FAKE_GEMINI_MODE: "consult-success"
    },
    "mcp-e2e-patch-validation"
  );

  try {
    const result = await connection.client.callTool({
      name: "ask_agent",
      arguments: {
        agent: "gemini",
        task: "Return a patch.",
        project_root: workspaceRoot,
        files: [],
        constraints: [],
        mode: "patch",
        apply: false
      }
    });

    assert.equal(result.isError, true);
    assert.match(getTextContent(result), /requires at least one file/i);
  } finally {
    await connection.close();
  }
});
