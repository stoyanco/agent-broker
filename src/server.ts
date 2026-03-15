import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  askAgentOutputSchema,
  askAgentStartRequestSchema,
  createAgentJobId,
  deleteConversation,
  deleteConversationInputSchema,
  deleteConversationOutputSchema,
  executePreparedAskAgent,
  listAgents,
  listConversations,
  listAgentsOutputSchema,
  listConversationsOutputSchema,
  type AskAgentExecutionResult,
  type PreparedAskAgentStartRequest,
  prepareAskAgentStartRequest
} from "./broker.js";
import { SERVER_NAME, SERVER_VERSION } from "./bridge.js";

const askAgentInputShape = {
  agent: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  mode: z.enum(["consult", "review", "patch", "rewrite"]).optional(),
  task: z.string().trim().min(1).optional(),
  project_root: z.string().trim().min(1).optional(),
  files: z.array(z.string().trim().min(1)).max(8).optional(),
  constraints: z.array(z.string().trim().min(1)).optional(),
  apply: z.boolean().optional(),
  apply_approved: z.boolean().optional(),
  conversation_mode: z.enum(["stateless", "new", "continue"]).optional(),
  conversation_id: z.string().trim().min(1).optional(),
  job_id: z.string().trim().min(1).optional()
};

const askAgentServerInputSchema = z.object(askAgentInputShape).superRefine((input, ctx) => {
  const hasJobId = typeof input.job_id === "string" && input.job_id.length > 0;
  const hasStartFields =
    input.agent !== undefined ||
    input.model !== undefined ||
    input.mode !== undefined ||
    input.task !== undefined ||
    input.project_root !== undefined ||
    input.files !== undefined ||
    input.constraints !== undefined ||
    input.apply !== undefined ||
    input.apply_approved !== undefined ||
    input.conversation_mode !== undefined ||
    input.conversation_id !== undefined;

  if (hasJobId && hasStartFields) {
    ctx.addIssue({
      code: "custom",
      message: "Poll requests may only include job_id."
    });
    return;
  }

  if (!hasJobId && !hasStartFields) {
    ctx.addIssue({
      code: "custom",
      message: "Provide either a full ask_agent request or a job_id to poll an existing job."
    });
    return;
  }

  if (!hasJobId && input.agent === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "agent is required for ask_agent start requests."
    });
  }

  if (!hasJobId && input.task === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "task is required for ask_agent start requests."
    });
  }

  if (!hasJobId && input.project_root === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "project_root is required for ask_agent start requests."
    });
  }
});

const askAgentOutputShape = {
  agent: z.string().trim().min(1),
  model: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  response: z.string().default(""),
  patches: z
    .array(
      z.object({
        path: z.string().trim().min(1),
        unified_diff: z.string().trim().min(1)
      })
    )
    .default([]),
  files: z.record(z.string(), z.string()).default({}),
  notes: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  applied: z.boolean().default(false),
  applied_files: z.array(z.string()).default([]),
  status: z.enum(["running", "completed"]).default("completed"),
  job_id: z.string().trim().min(1),
  retry_after_ms: z.number().int().positive().default(5000),
  conversation_id: z.string().trim().min(1).optional()
};

const listAgentsOutputShape = {
  agents: z.array(
    z.object({
      agent: z.string().trim().min(1),
      enabled: z.boolean(),
      default_model: z.string().trim().min(1),
      allowed_models: z.array(z.string().trim().min(1)).optional(),
      allowed_project_roots: z.array(z.string().trim().min(1)).optional(),
      allowed_conversation_modes: z.array(z.enum(["stateless", "new", "continue"])),
      allowed_modes: z.array(z.enum(["consult", "review", "patch", "rewrite"])),
      allow_apply: z.boolean(),
      require_apply_approval: z.boolean(),
      max_files: z.number().int().positive(),
      max_task_chars: z.number().int().positive().optional(),
      max_constraints_chars: z.number().int().positive().optional(),
      timeout_ms: z.number().int().positive().optional(),
      max_poll_attempts: z.number().int().positive().optional(),
      supports_model_override: z.boolean(),
      supports_resume: z.boolean(),
      supports_headless: z.boolean(),
      supports_patch: z.boolean(),
      supports_apply: z.boolean(),
      supports_session_export: z.boolean()
    })
  )
};

const deleteConversationInputShape = {
  conversation_id: z.string().trim().min(1)
};

const deleteConversationOutputShape = {
  conversation_id: z.string().trim().min(1),
  deleted: z.boolean(),
  removed_profile: z.boolean()
};

const listConversationsOutputShape = {
  conversations: z.array(
    z.object({
      conversation_id: z.string().trim().min(1),
      agent: z.string().trim().min(1),
      project_root: z.string().trim().min(1),
      model: z.string().trim().min(1),
      created_at: z.string().trim().min(1),
      updated_at: z.string().trim().min(1)
    })
  )
};

const DEFAULT_INITIAL_WAIT_MS = 15_000;
const DEFAULT_POLL_WAIT_MS = 15_000;
const DEFAULT_JOB_CLEANUP_INTERVAL_MS = 60_000;
export const COMPLETED_JOB_TTL_MS = 15 * 60_000;

type AgentJob = {
  id: string;
  agent: string;
  model: string;
  conversationId?: string;
  pollAttempts: number;
  maxPollAttempts?: number;
  startedAt: number;
  completedAt?: number;
  result?: z.output<typeof askAgentOutputSchema>;
  error?: Error;
  promise: Promise<void>;
};

type AgentJobExecutor = (prepared: PreparedAskAgentStartRequest) => Promise<AskAgentExecutionResult>;

const agentJobs = new Map<string, AgentJob>();
let agentJobCleanupTimer: ReturnType<typeof setInterval> | null = null;

function getInitialWaitMs(): number {
  const raw = Number.parseInt(
    process.env.AGENT_BROKER_INITIAL_WAIT_MS ??
      process.env.CODEX_COUNCIL_INITIAL_WAIT_MS ??
      process.env.GEMINI_BRIDGE_INITIAL_WAIT_MS ??
      "",
    10
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INITIAL_WAIT_MS;
}

function getPollWaitMs(): number {
  const raw = Number.parseInt(
    process.env.AGENT_BROKER_POLL_WAIT_MS ??
      process.env.CODEX_COUNCIL_POLL_WAIT_MS ??
      process.env.GEMINI_BRIDGE_POLL_WAIT_MS ??
      "",
    10
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_POLL_WAIT_MS;
}

export function cleanupExpiredJobs(now = Date.now()): void {
  for (const [jobId, job] of agentJobs.entries()) {
    if (job.completedAt !== undefined && now - job.completedAt > COMPLETED_JOB_TTL_MS) {
      agentJobs.delete(jobId);
    }
  }
}

export function ensureAgentJobCleanupTimer(intervalMs = DEFAULT_JOB_CLEANUP_INTERVAL_MS): void {
  if (agentJobCleanupTimer) {
    return;
  }

  agentJobCleanupTimer = setInterval(() => {
    cleanupExpiredJobs();
  }, intervalMs);
  agentJobCleanupTimer.unref?.();
}

export function stopAgentJobCleanupTimerForTests(): void {
  if (!agentJobCleanupTimer) {
    return;
  }

  clearInterval(agentJobCleanupTimer);
  agentJobCleanupTimer = null;
}

export function resetAgentJobsForTests(): void {
  agentJobs.clear();
  stopAgentJobCleanupTimerForTests();
}

function createRunningResult(job: AgentJob) {
  return askAgentOutputSchema.parse({
    agent: job.agent,
    model: job.model,
    summary: `Agent job ${job.id} is still running. Poll ask_agent again with this job_id.`,
    response: "",
    patches: [],
    files: {},
    notes: [],
    warnings: [],
    applied: false,
    applied_files: [],
    status: "running",
    job_id: job.id,
    retry_after_ms: 5000,
    conversation_id: job.conversationId
  });
}

export async function getOrCreateAgentJob(
  rawInput: z.input<typeof askAgentStartRequestSchema>,
  jobId = createAgentJobId(),
  executor: AgentJobExecutor = executePreparedAskAgent
): Promise<AgentJob> {
  ensureAgentJobCleanupTimer();
  const existingJob = agentJobs.get(jobId);
  if (existingJob) {
    return existingJob;
  }

  const prepared = await prepareAskAgentStartRequest(rawInput);

  let job!: AgentJob;
  const promise = executor(prepared)
    .then((result) => {
      job.result = askAgentOutputSchema.parse({
        ...result,
        status: "completed",
        job_id: jobId,
        retry_after_ms: 5000
      });
      job.completedAt = Date.now();
    })
    .catch((error: unknown) => {
      job.error = error instanceof Error ? error : new Error(String(error));
      job.completedAt = Date.now();
    });

  job = {
    id: jobId,
    agent: prepared.request.agent,
    model: prepared.model,
    conversationId: prepared.conversationId,
    pollAttempts: 0,
    maxPollAttempts: prepared.policy.maxPollAttempts,
    startedAt: Date.now(),
    promise
  };

  agentJobs.set(jobId, job);
  return job;
}

export async function waitForAgentJob(
  job: AgentJob,
  waitMs: number
): Promise<
  | { status: "running"; result: z.output<typeof askAgentOutputSchema> }
  | { status: "completed"; result: z.output<typeof askAgentOutputSchema> }
> {
  if (job.result) {
    return {
      status: "completed",
      result: job.result
    };
  }

  if (job.error) {
    throw job.error;
  }

  const outcome = await Promise.race([
    job.promise.then(() => ({ status: "settled" as const })),
    new Promise<{ status: "running" }>((resolve) => {
      setTimeout(() => resolve({ status: "running" }), waitMs);
    })
  ]);

  if (outcome.status === "settled") {
    if (job.error) {
      throw job.error;
    }

    if (job.result) {
      return {
        status: "completed",
        result: job.result
      };
    }

    throw new Error(`Agent job "${job.id}" settled without a result.`);
  }

  if (job.error) {
    throw job.error;
  }

  return {
    status: "running",
    result: createRunningResult(job)
  };
}

function createAskAgentToolHandler() {
  return async (input: z.output<typeof askAgentServerInputSchema>) => {
    cleanupExpiredJobs();

    const parsedInput = askAgentServerInputSchema.parse(input);

    if (parsedInput.job_id) {
      const job = agentJobs.get(parsedInput.job_id);
      if (!job) {
        throw new Error(`No running agent job found for job_id "${parsedInput.job_id}".`);
      }

      if (!job.result && !job.error && job.maxPollAttempts !== undefined) {
        job.pollAttempts += 1;
        if (job.pollAttempts > job.maxPollAttempts) {
          throw new Error(
            `Agent job "${job.id}" exceeded the broker max_poll_attempts limit of ${job.maxPollAttempts}.`
          );
        }
      }

      const outcome = await waitForAgentJob(job, getPollWaitMs());
      const result = askAgentOutputSchema.parse(outcome.result);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2)
          }
        ],
        structuredContent: result
      };
    }

    const startRequest = askAgentStartRequestSchema.parse({
      agent: parsedInput.agent!,
      model: parsedInput.model,
      mode: parsedInput.mode,
      task: parsedInput.task!,
      project_root: parsedInput.project_root!,
      files: parsedInput.files,
      constraints: parsedInput.constraints,
      apply: parsedInput.apply,
      apply_approved: parsedInput.apply_approved,
      conversation_mode: parsedInput.conversation_mode,
      conversation_id: parsedInput.conversation_id
    });
    const job = await getOrCreateAgentJob(startRequest);
    const outcome = await waitForAgentJob(job, getInitialWaitMs());
    const result = askAgentOutputSchema.parse(outcome.result);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2)
        }
      ],
      structuredContent: result
    };
  };
}

function createListAgentsToolHandler() {
  return async () => {
    const result = listAgentsOutputSchema.parse(listAgents());
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2)
        }
      ],
      structuredContent: result
    };
  };
}

function createListConversationsToolHandler() {
  return async () => {
    const result = listConversationsOutputSchema.parse(await listConversations());
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2)
        }
      ],
      structuredContent: result
    };
  };
}

function createDeleteConversationToolHandler() {
  return async (input: z.output<typeof deleteConversationInputSchema>) => {
    const parsedInput = deleteConversationInputSchema.parse(input);
    const result = deleteConversationOutputSchema.parse(await deleteConversation(parsedInput));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2)
        }
      ],
      structuredContent: result
    };
  };
}

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION
    },
    {
      instructions: [
        "Use ask_agent when Codex wants a second model for consultation, code review, patch generation, or rewrite assistance.",
        "Agent Broker is a local broker. It routes one request to one configured agent runtime and returns normalized outputs.",
        "Use list_agents first when you need to discover which runtimes are enabled and what capabilities they support.",
        "Use list_conversations to inspect resumable broker-owned conversations and delete_conversation to clean up stale ones.",
        "For continuity, send conversation_mode=new to start a new resumable thread or conversation_mode=continue with conversation_id to resume one.",
        "After the tool returns, Codex should validate edits carefully, run build/typecheck/tests as appropriate, and repair integration issues."
      ].join(" ")
    }
  );

  server.registerTool(
    "ask_agent",
    {
      title: "Ask A Local Agent Runtime",
      description:
        "Delegates consultation, review, patch generation, or rewrite assistance to a configured local agent runtime through the broker. Long-running jobs can return status=running with a job_id for polling.",
      inputSchema: askAgentInputShape,
      outputSchema: askAgentOutputShape
    },
    createAskAgentToolHandler()
  );

  server.registerTool(
    "list_agents",
    {
      title: "List Available Agent Runtimes",
      description:
        "Lists the local agent runtimes currently available through the broker and their declared capabilities.",
      inputSchema: {},
      outputSchema: listAgentsOutputShape
    },
    createListAgentsToolHandler()
  );

  server.registerTool(
    "list_conversations",
    {
      title: "List Broker Conversations",
      description:
        "Lists resumable broker-owned conversations with their agent, project root, model, and timestamps.",
      inputSchema: {},
      outputSchema: listConversationsOutputShape
    },
    createListConversationsToolHandler()
  );

  server.registerTool(
    "delete_conversation",
    {
      title: "Delete A Broker Conversation",
      description:
        "Deletes a stored broker conversation by conversation_id and removes any managed provider profile owned by that conversation.",
      inputSchema: deleteConversationInputShape,
      outputSchema: deleteConversationOutputShape
    },
    createDeleteConversationToolHandler()
  );

  return server;
}

export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
