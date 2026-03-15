import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entrypoint = path.join(workspaceRoot, "dist", "cli.js");
const requestedTargetAgent = process.env.SMOKE_AGENT;
const maxPollAttempts = Number.parseInt(process.env.SMOKE_AGENT_MAX_POLLS ?? "", 10) || 30;
const defaultPollDelayMs = Number.parseInt(process.env.SMOKE_AGENT_POLL_DELAY_MS ?? "", 10) || 1_000;
const smokeAgentPreference = ["codex", "gemini", "claude"];

function createStringEnv() {
  return Object.fromEntries(
    Object.entries({
      ...process.env,
      AGENT_BROKER_INITIAL_WAIT_MS:
        process.env.AGENT_BROKER_INITIAL_WAIT_MS ?? process.env.CODEX_COUNCIL_INITIAL_WAIT_MS ?? "2000",
      AGENT_BROKER_POLL_WAIT_MS:
        process.env.AGENT_BROKER_POLL_WAIT_MS ?? process.env.CODEX_COUNCIL_POLL_WAIT_MS ?? "2000",
      GEMINI_BRIDGE_TIMEOUT_MS: process.env.GEMINI_BRIDGE_TIMEOUT_MS ?? "240000"
    }).filter((entry) => typeof entry[1] === "string")
  );
}

function getToolErrorText(result) {
  return result.content?.find((item) => item.type === "text")?.text ?? "Unknown MCP tool error.";
}

async function sleep(durationMs) {
  await new Promise((resolve) => setTimeout(resolve, durationMs));
}

function isWithinDirectory(rootPath, candidatePath) {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedCandidate = path.resolve(candidatePath);
  const rootWithSeparator = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(rootWithSeparator);
}

function resolveSmokeAgent(agents) {
  const enabledAgents = agents.filter((agent) => agent.enabled);

  if (requestedTargetAgent) {
    const matchingAgent = enabledAgents.find((agent) => agent.agent === requestedTargetAgent);
    if (!matchingAgent) {
      throw new Error(
        `Requested smoke agent "${requestedTargetAgent}" is not enabled. Enabled agents: ${enabledAgents.map((agent) => agent.agent).join(", ")}`
      );
    }

    return matchingAgent.agent;
  }

  for (const preferredAgent of smokeAgentPreference) {
    if (enabledAgents.some((agent) => agent.agent === preferredAgent)) {
      return preferredAgent;
    }
  }

  if (enabledAgents.length === 0) {
    throw new Error("No enabled agents are available for smoke testing.");
  }

  return enabledAgents[0].agent;
}

function assertSmokePolicyCompatibility(agent) {
  if (!agent) {
    throw new Error("Smoke agent metadata is missing from list_agents.");
  }

  if (Array.isArray(agent.allowed_project_roots) && agent.allowed_project_roots.length > 0) {
    const isAllowed = agent.allowed_project_roots.some((allowedRoot) => isWithinDirectory(allowedRoot, workspaceRoot));

    if (!isAllowed) {
      throw new Error(
        `Smoke workspace "${workspaceRoot}" is outside allowed_project_roots for agent "${agent.agent}": ${agent.allowed_project_roots.join(", ")}`
      );
    }
  }
}

async function main() {
  await access(entrypoint).catch(() => {
    throw new Error('Build output is missing. Run "npm run build" before "npm run smoke:agent".');
  });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint],
    cwd: workspaceRoot,
    env: createStringEnv(),
    stderr: "inherit"
  });
  const client = new Client({
    name: "agent-broker-smoke",
    version: "1.0.0"
  });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();

    if (!toolNames.includes("ask_agent") || !toolNames.includes("list_agents")) {
      throw new Error(`Expected ask_agent and list_agents, received: ${toolNames.join(", ")}`);
    }

    const listed = await client.callTool({
      name: "list_agents",
      arguments: {}
    });
    if (listed.isError) {
      throw new Error(getToolErrorText(listed));
    }
    const listedAgents = listed.structuredContent?.agents ?? [];
    const targetAgent = resolveSmokeAgent(listedAgents);
    const targetAgentMetadata = listedAgents.find((agent) => agent.agent === targetAgent);
    assertSmokePolicyCompatibility(targetAgentMetadata);

    let result = await client.callTool({
      name: "ask_agent",
      arguments: {
        agent: targetAgent,
        task: "Reply in one short paragraph confirming the local Agent Broker smoke path works.",
        project_root: workspaceRoot,
        files: [],
        constraints: ["tone: concise, technical"],
        mode: "consult",
        apply: false
      }
    });

    if (result.isError) {
      throw new Error(getToolErrorText(result));
    }

    for (let attempt = 0; result.structuredContent?.status === "running" && attempt < maxPollAttempts; attempt += 1) {
      const suggestedDelayMs =
        typeof result.structuredContent.retry_after_ms === "number" && result.structuredContent.retry_after_ms > 0
          ? result.structuredContent.retry_after_ms
          : defaultPollDelayMs;

      await sleep(suggestedDelayMs);
      result = await client.callTool({
        name: "ask_agent",
        arguments: {
          job_id: result.structuredContent.job_id
        }
      });

      if (result.isError) {
        throw new Error(getToolErrorText(result));
      }
    }

    if (result.structuredContent?.status !== "completed") {
      throw new Error(
        `Smoke test did not complete after ${maxPollAttempts} poll attempts. Last status: ${result.structuredContent?.status ?? "unknown"}`
      );
    }

    console.log(JSON.stringify(result.structuredContent, null, 2));
  } finally {
    await transport.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(`[agent-broker] Smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
