import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as z from "zod/v4";
import {
  askGeminiOutputSchema,
  DEFAULT_GEMINI_MODEL,
  executeAskGemini,
  geminiModeSchema,
  resolveGeminiModel
} from "./bridge.js";
import { DEFAULT_CLAUDE_MODEL, executeAskClaude, resolveClaudeModel } from "./claude.js";
import { DEFAULT_CODEX_MODEL, executeAskCodex, resolveCodexModel } from "./codex.js";
import { loadBrokerConfig, resolveAgentPolicy, resolveConversationPolicy } from "./config.js";

export const BROKER_HOME_ENV = "AGENT_BROKER_HOME";
const LEGACY_BROKER_HOME_ENV = "CODEX_COUNCIL_HOME";
const BROKER_STATE_FILENAME = "broker-state.json";
const CONVERSATIONS_DIRECTORY = "conversations";

export const agentNameSchema = z.enum(["gemini", "claude", "codex"]);
export const conversationModeSchema = z.enum(["stateless", "new", "continue"]);
export const agentModeSchema = geminiModeSchema;

export const askAgentStartRequestSchema = z
  .object({
    agent: agentNameSchema,
    model: z.string().trim().min(1).optional(),
    mode: agentModeSchema.default("consult"),
    task: z.string().trim().min(1),
    project_root: z.string().trim().min(1),
    files: z.array(z.string().trim().min(1)).max(8).default([]),
    constraints: z.array(z.string().trim().min(1)).default([]),
    apply: z.boolean().default(false),
    apply_approved: z.boolean().default(false),
    conversation_mode: conversationModeSchema.default("stateless"),
    conversation_id: z.string().trim().min(1).optional()
  })
  .superRefine((input, ctx) => {
    const requiresFiles = input.mode === "patch" || input.mode === "rewrite";

    if (requiresFiles && input.files.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: `mode="${input.mode}" requires at least one file.`
      });
    }

    if (input.apply && input.mode !== "patch" && input.mode !== "rewrite") {
      ctx.addIssue({
        code: "custom",
        message: 'apply=true is only supported for mode="patch" or mode="rewrite".'
      });
    }

    if (!input.apply && input.apply_approved) {
      ctx.addIssue({
        code: "custom",
        message: "apply_approved is only allowed when apply=true."
      });
    }

    if (input.conversation_mode === "stateless" && input.conversation_id !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: 'conversation_id is not allowed when conversation_mode="stateless".'
      });
    }

    if (input.conversation_mode === "continue" && input.conversation_id === undefined) {
      ctx.addIssue({
        code: "custom",
        message: 'conversation_id is required when conversation_mode="continue".'
      });
    }
  });

export const askAgentPollRequestSchema = z
  .object({
    job_id: z.string().trim().min(1)
  })
  .strict();

export const askAgentExecutionResultSchema = askGeminiOutputSchema.extend({
  agent: agentNameSchema,
  model: z.string().trim().min(1),
  conversation_id: z.string().trim().min(1).optional()
});

export const askAgentOutputSchema = askAgentExecutionResultSchema.extend({
  status: z.enum(["running", "completed"]).default("completed"),
  job_id: z.string().trim().min(1),
  retry_after_ms: z.number().int().positive().default(5000)
});

export const listAgentsOutputSchema = z.object({
  agents: z.array(
    z.object({
      agent: agentNameSchema,
      enabled: z.boolean(),
      default_model: z.string().trim().min(1),
      allowed_models: z.array(z.string().trim().min(1)).optional(),
      allowed_project_roots: z.array(z.string().trim().min(1)).optional(),
      allowed_conversation_modes: z.array(conversationModeSchema),
      allowed_modes: z.array(agentModeSchema),
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
});

export const listConversationsOutputSchema = z.object({
  conversations: z.array(
    z.object({
      conversation_id: z.string().trim().min(1),
      agent: agentNameSchema,
      project_root: z.string().trim().min(1),
      model: z.string().trim().min(1),
      created_at: z.string().trim().min(1),
      updated_at: z.string().trim().min(1)
    })
  )
});

export const deleteConversationInputSchema = z.object({
  conversation_id: z.string().trim().min(1)
});

export const deleteConversationOutputSchema = z.object({
  conversation_id: z.string().trim().min(1),
  deleted: z.boolean(),
  removed_profile: z.boolean().default(false)
});

export type AgentName = z.output<typeof agentNameSchema>;
export type AgentMode = z.output<typeof agentModeSchema>;
export type ConversationMode = z.output<typeof conversationModeSchema>;
export type AskAgentStartRequest = z.output<typeof askAgentStartRequestSchema>;
export type AskAgentPollRequest = z.output<typeof askAgentPollRequestSchema>;
export type AskAgentExecutionResult = z.output<typeof askAgentExecutionResultSchema>;
export type AskAgentOutput = z.output<typeof askAgentOutputSchema>;
export type ListAgentsOutput = z.output<typeof listAgentsOutputSchema>;
export type ListConversationsOutput = z.output<typeof listConversationsOutputSchema>;
export type DeleteConversationOutput = z.output<typeof deleteConversationOutputSchema>;

function getTotalConstraintChars(constraints: string[]): number {
  return constraints.reduce((total, constraint) => total + constraint.length, 0);
}

function isWithinDirectory(rootPath: string, candidatePath: string): boolean {
  const rootWithSeparator = rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`;
  return candidatePath === rootPath || candidatePath.startsWith(rootWithSeparator);
}

async function assertAllowedProjectRoot(agent: AgentName, canonicalProjectRoot: string, stateHome?: string): Promise<void> {
  const policy = getAgentPolicy(agent, stateHome);

  if (policy.allowedProjectRoots === undefined) {
    return;
  }

  const canonicalAllowedRoots = await Promise.all(
    policy.allowedProjectRoots.map(async (allowedRoot) => {
      const canonicalAllowedRoot = await realpath(allowedRoot).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          throw new Error(`Agent "${agent}" has a configured allowed_project_roots entry that does not exist: "${allowedRoot}".`);
        }

        throw error;
      });
      const rootStats = await stat(canonicalAllowedRoot);

      if (!rootStats.isDirectory()) {
        throw new Error(`Agent "${agent}" has a configured allowed_project_roots entry that is not a directory: "${allowedRoot}".`);
      }

      return canonicalAllowedRoot;
    })
  );

  if (!canonicalAllowedRoots.some((allowedRoot) => isWithinDirectory(allowedRoot, canonicalProjectRoot))) {
    throw new Error(
      `Agent "${agent}" is restricted to configured project roots and does not allow "${canonicalProjectRoot}".`
    );
  }
}

export interface AgentCapabilities {
  agent: AgentName;
  defaultModel: string;
  supportsModelOverride: boolean;
  supportsResume: boolean;
  supportsHeadless: boolean;
  supportsPatch: boolean;
  supportsApply: boolean;
  supportsSessionExport: boolean;
}

export interface ConversationRecord {
  conversation_id: string;
  agent: AgentName;
  project_root: string;
  model: string;
  provider_session_handle: string;
  created_at: string;
  updated_at: string;
}

type BrokerState = {
  version: 1;
  conversations: Record<string, ConversationRecord>;
};

type PrepareContext = {
  stateHome?: string;
  now?: Date;
};

type ExecuteContext = PrepareContext;

export interface PreparedAskAgentStartRequest {
  request: AskAgentStartRequest;
  canonicalProjectRoot: string;
  capabilities: AgentCapabilities;
  policy: ReturnType<typeof getAgentPolicy>;
  model: string;
  conversationId?: string;
  conversationRecord?: ConversationRecord;
  newConversationRecord?: ConversationRecord;
}

interface AgentAdapter {
  capabilities: AgentCapabilities;
  supportedModes: ReadonlySet<AgentMode>;
  execute(
    prepared: PreparedAskAgentStartRequest,
    context?: ExecuteContext
  ): Promise<{ result: AskAgentExecutionResult; providerSessionHandle?: string }>;
}

function createDefaultBrokerState(): BrokerState {
  return {
    version: 1,
    conversations: {}
  };
}

function getBrokerHome(stateHome?: string): string {
  return (
    stateHome ??
    process.env[BROKER_HOME_ENV] ??
    process.env[LEGACY_BROKER_HOME_ENV] ??
    path.join(os.homedir(), ".agent-broker")
  );
}

function getBrokerStatePath(stateHome?: string): string {
  return path.join(getBrokerHome(stateHome), BROKER_STATE_FILENAME);
}

function getConversationProfilesRoot(stateHome?: string): string {
  return path.join(getBrokerHome(stateHome), CONVERSATIONS_DIRECTORY);
}

function createConversationDirectoryName(conversationId: string): string {
  return createHash("sha256").update(conversationId).digest("hex").slice(0, 16);
}

function createConversationProfileHome(conversationId: string, stateHome?: string): string {
  return path.join(getConversationProfilesRoot(stateHome), createConversationDirectoryName(conversationId));
}

async function ensureBrokerHome(stateHome?: string): Promise<void> {
  await mkdir(getBrokerHome(stateHome), { recursive: true });
}

async function loadBrokerState(stateHome?: string): Promise<BrokerState> {
  const statePath = getBrokerStatePath(stateHome);
  const raw = await readFile(statePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  });

  if (raw === null) {
    return createDefaultBrokerState();
  }

  const parsed = JSON.parse(raw) as Partial<BrokerState>;
  if (parsed.version !== 1 || typeof parsed.conversations !== "object" || parsed.conversations === null) {
    throw new Error(`Broker state file is invalid: "${statePath}".`);
  }

  return {
    version: 1,
    conversations: Object.fromEntries(
      Object.entries(parsed.conversations).map(([conversationId, record]) => [
        conversationId,
        z
          .object({
            conversation_id: z.string().trim().min(1),
            agent: agentNameSchema,
            project_root: z.string().trim().min(1),
            model: z.string().trim().min(1),
            provider_session_handle: z.string().trim().min(1),
            created_at: z.string().trim().min(1),
            updated_at: z.string().trim().min(1)
          })
          .parse(record)
      ])
    )
  };
}

async function saveBrokerState(state: BrokerState, stateHome?: string): Promise<void> {
  await ensureBrokerHome(stateHome);
  const statePath = getBrokerStatePath(stateHome);
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

async function upsertConversationRecord(record: ConversationRecord, stateHome?: string): Promise<void> {
  const state = await loadBrokerState(stateHome);
  state.conversations[record.conversation_id] = record;
  await saveBrokerState(state, stateHome);
}

async function removeConversationRecord(conversationId: string, stateHome?: string): Promise<void> {
  const state = await loadBrokerState(stateHome);
  if (!(conversationId in state.conversations)) {
    return;
  }

  delete state.conversations[conversationId];
  await saveBrokerState(state, stateHome);
}

async function getConversationRecord(conversationId: string, stateHome?: string): Promise<ConversationRecord | undefined> {
  const state = await loadBrokerState(stateHome);
  return state.conversations[conversationId];
}

async function listConversationRecords(stateHome?: string): Promise<ConversationRecord[]> {
  const state = await loadBrokerState(stateHome);
  return Object.values(state.conversations).sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

function getConversationMaxAgeMs(stateHome?: string): number | undefined {
  return resolveConversationPolicy(loadBrokerConfig(stateHome)).maxAgeMs;
}

async function deleteConversationRecordInternal(
  conversation: ConversationRecord,
  stateHome?: string
): Promise<{ removedProfile: boolean }> {
  let removedProfile = false;

  if (conversation.agent === "gemini") {
    const profilesRoot = getConversationProfilesRoot(stateHome);
    const candidateProfile = conversation.provider_session_handle;
    const relativeProfilePath = path.relative(profilesRoot, candidateProfile);
    const isManagedProfile =
      relativeProfilePath.length > 0 && !relativeProfilePath.startsWith("..") && !path.isAbsolute(relativeProfilePath);

    if (isManagedProfile) {
      await rm(candidateProfile, { recursive: true, force: true });
      removedProfile = true;
    }
  }

  await removeConversationRecord(conversation.conversation_id, stateHome);
  return { removedProfile };
}

async function resolveCanonicalProjectRoot(projectRoot: string): Promise<string> {
  if (!path.isAbsolute(projectRoot)) {
    throw new Error("project_root must be an absolute path.");
  }

  const canonicalProjectRoot = await realpath(projectRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new Error(`project_root does not exist: "${projectRoot}".`);
    }

    throw error;
  });
  const rootStats = await stat(canonicalProjectRoot);

  if (!rootStats.isDirectory()) {
    throw new Error(`project_root must point to a directory: "${projectRoot}".`);
  }

  return canonicalProjectRoot;
}

function createConversationId(): string {
  return randomBytes(8).toString("hex");
}

export function createAgentJobId(): string {
  return randomBytes(8).toString("hex");
}

function toIsoString(date: Date): string {
  return date.toISOString();
}

function getGeminiCapabilities(): AgentCapabilities {
  return {
    agent: "gemini",
    defaultModel: DEFAULT_GEMINI_MODEL,
    supportsModelOverride: true,
    supportsResume: true,
    supportsHeadless: true,
    supportsPatch: true,
    supportsApply: true,
    supportsSessionExport: true
  };
}

function getClaudeCapabilities(): AgentCapabilities {
  return {
    agent: "claude",
    defaultModel: DEFAULT_CLAUDE_MODEL,
    supportsModelOverride: true,
    supportsResume: true,
    supportsHeadless: true,
    supportsPatch: false,
    supportsApply: false,
    supportsSessionExport: true
  };
}

function getCodexCapabilities(): AgentCapabilities {
  return {
    agent: "codex",
    defaultModel: DEFAULT_CODEX_MODEL,
    supportsModelOverride: true,
    supportsResume: true,
    supportsHeadless: true,
    supportsPatch: false,
    supportsApply: false,
    supportsSessionExport: true
  };
}

const geminiAdapter: AgentAdapter = {
  capabilities: getGeminiCapabilities(),
  supportedModes: new Set(["consult", "review", "patch", "rewrite"]),
  async execute(prepared): Promise<{ result: AskAgentExecutionResult; providerSessionHandle?: string }> {
    const profileHome =
      prepared.conversationRecord?.provider_session_handle ??
      prepared.newConversationRecord?.provider_session_handle;
    const resumeSession = prepared.conversationRecord ? "latest" : undefined;
    const result = await executeAskGemini(
      {
        task: prepared.request.task,
        project_root: prepared.canonicalProjectRoot,
        files: prepared.request.files,
        constraints: prepared.request.constraints,
        mode: prepared.request.mode,
        apply: prepared.request.apply
      },
      {
        geminiCli: {
          model: prepared.model,
          timeoutMs: prepared.policy.timeoutMs,
          profileHome,
          resumeSession
        }
      }
    );

    return {
      result: askAgentExecutionResultSchema.parse({
        ...result,
        agent: "gemini",
        model: prepared.model,
        conversation_id: prepared.conversationId
      }),
      providerSessionHandle: profileHome
    };
  }
};

const claudeAdapter: AgentAdapter = {
  capabilities: getClaudeCapabilities(),
  supportedModes: new Set(["consult", "review"]),
  async execute(prepared): Promise<{ result: AskAgentExecutionResult; providerSessionHandle?: string }> {
    const result = await executeAskClaude(
      {
        task: prepared.request.task,
        project_root: prepared.canonicalProjectRoot,
        files: prepared.request.files,
        constraints: prepared.request.constraints,
        mode: prepared.request.mode,
        apply: prepared.request.apply
      },
      {
        claudeCli: {
          model: prepared.model,
          timeoutMs: prepared.policy.timeoutMs,
          sessionId: prepared.newConversationRecord?.provider_session_handle,
          resumeSessionId: prepared.conversationRecord?.provider_session_handle,
          disableSessionPersistence: prepared.request.conversation_mode === "stateless"
        }
      }
    );

    return {
      result: askAgentExecutionResultSchema.parse({
        ...result,
        agent: "claude",
        model: prepared.model,
        conversation_id: prepared.conversationId
      }),
      providerSessionHandle:
        prepared.conversationRecord?.provider_session_handle ?? prepared.newConversationRecord?.provider_session_handle
    };
  }
};

const codexAdapter: AgentAdapter = {
  capabilities: getCodexCapabilities(),
  supportedModes: new Set(["consult", "review"]),
  async execute(prepared): Promise<{ result: AskAgentExecutionResult; providerSessionHandle?: string }> {
    const execution = await executeAskCodex(
      {
        task: prepared.request.task,
        project_root: prepared.canonicalProjectRoot,
        files: prepared.request.files,
        constraints: prepared.request.constraints,
        mode: prepared.request.mode,
        apply: prepared.request.apply
      },
      {
        codexCli: {
          model: prepared.model,
          timeoutMs: prepared.policy.timeoutMs,
          resumeSessionId: prepared.conversationRecord?.provider_session_handle,
          ephemeral: prepared.request.conversation_mode === "stateless"
        }
      }
    );

    return {
      result: askAgentExecutionResultSchema.parse({
        ...execution.result,
        agent: "codex",
        model: prepared.model,
        conversation_id: prepared.conversationId
      }),
      providerSessionHandle: execution.threadId ?? prepared.conversationRecord?.provider_session_handle
    };
  }
};

function getAgentAdapter(agent: AgentName): AgentAdapter {
  switch (agent) {
    case "gemini":
      return geminiAdapter;
    case "claude":
      return claudeAdapter;
    case "codex":
      return codexAdapter;
  }
}

function getAgentPolicy(agent: AgentName, stateHome?: string) {
  return resolveAgentPolicy(agent, loadBrokerConfig(stateHome));
}

function getSelectedModel(
  request: AskAgentStartRequest,
  capabilities: AgentCapabilities,
  stateHome?: string
): string {
  if (request.model && !capabilities.supportsModelOverride) {
    throw new Error(`Agent "${request.agent}" does not support model overrides.`);
  }

  const policy = getAgentPolicy(request.agent, stateHome);
  const requestedModel = request.model ?? policy.defaultModel;

  if (policy.allowedModels && !policy.allowedModels.includes(requestedModel)) {
    throw new Error(
      `Agent "${request.agent}" only allows configured models: ${policy.allowedModels.join(", ")}. Requested "${requestedModel}".`
    );
  }

  switch (request.agent) {
    case "gemini":
      return resolveGeminiModel({
        model: requestedModel
      });
    case "claude":
      return resolveClaudeModel({
        model: requestedModel
      });
    case "codex":
      return resolveCodexModel({
        model: requestedModel
      });
  }
}

function createProviderSessionHandle(agent: AgentName, conversationId: string, stateHome?: string): string {
  switch (agent) {
    case "gemini":
      return createConversationProfileHome(conversationId, stateHome);
    case "claude":
      return randomUUID();
    case "codex":
      return `pending:${conversationId}`;
  }
}

function getConversationTimestamp(context?: PrepareContext): Date {
  return context?.now ?? new Date();
}

export async function cleanupExpiredConversations(
  stateHome?: string,
  now = new Date()
): Promise<{ deleted: number; removed_profiles: number }> {
  const maxAgeMs = getConversationMaxAgeMs(stateHome);

  if (maxAgeMs === undefined) {
    return {
      deleted: 0,
      removed_profiles: 0
    };
  }

  const cutoffTime = now.getTime() - maxAgeMs;
  const conversations = await listConversationRecords(stateHome);
  let deleted = 0;
  let removedProfiles = 0;

  for (const conversation of conversations) {
    const updatedAtTime = Date.parse(conversation.updated_at);

    if (!Number.isFinite(updatedAtTime) || updatedAtTime > cutoffTime) {
      continue;
    }

    const deletion = await deleteConversationRecordInternal(conversation, stateHome);
    deleted += 1;
    if (deletion.removedProfile) {
      removedProfiles += 1;
    }
  }

  return {
    deleted,
    removed_profiles: removedProfiles
  };
}

function createConversationRecordForNewRequest(
  request: AskAgentStartRequest,
  canonicalProjectRoot: string,
  model: string,
  stateHome?: string,
  now = new Date()
): ConversationRecord {
  const conversationId = request.conversation_id ?? createConversationId();

  return {
    conversation_id: conversationId,
    agent: request.agent,
    project_root: canonicalProjectRoot,
    model,
    provider_session_handle: createProviderSessionHandle(request.agent, conversationId, stateHome),
    created_at: toIsoString(now),
    updated_at: toIsoString(now)
  };
}

export async function prepareAskAgentStartRequest(
  rawInput: z.input<typeof askAgentStartRequestSchema>,
  context?: PrepareContext
): Promise<PreparedAskAgentStartRequest> {
  const request = askAgentStartRequestSchema.parse(rawInput);
  const stateHome = context?.stateHome;
  await cleanupExpiredConversations(stateHome, getConversationTimestamp(context));
  const capabilities = getAgentAdapter(request.agent).capabilities;
  const adapter = getAgentAdapter(request.agent);
  const policy = getAgentPolicy(request.agent, stateHome);
  const canonicalProjectRoot = await resolveCanonicalProjectRoot(request.project_root);

  if (!policy.enabled) {
    throw new Error(`Agent "${request.agent}" is disabled by broker policy.`);
  }

  await assertAllowedProjectRoot(request.agent, canonicalProjectRoot, stateHome);

  if (!policy.allowedConversationModes.includes(request.conversation_mode)) {
    throw new Error(
      `Agent "${request.agent}" does not allow conversation_mode="${request.conversation_mode}" by broker policy.`
    );
  }

  if (!adapter.supportedModes.has(request.mode)) {
    throw new Error(`Agent "${request.agent}" does not support mode="${request.mode}".`);
  }

  if (!policy.allowedModes.includes(request.mode)) {
    throw new Error(`Agent "${request.agent}" is disabled for mode="${request.mode}" by broker policy.`);
  }

  if (request.files.length > policy.maxFiles) {
    throw new Error(
      `Agent "${request.agent}" allows at most ${policy.maxFiles} file${policy.maxFiles === 1 ? "" : "s"} per request by broker policy.`
    );
  }

  if (policy.maxTaskChars !== undefined && request.task.length > policy.maxTaskChars) {
    throw new Error(
      `Agent "${request.agent}" allows at most ${policy.maxTaskChars} task characters by broker policy.`
    );
  }

  if (
    policy.maxConstraintsChars !== undefined &&
    getTotalConstraintChars(request.constraints) > policy.maxConstraintsChars
  ) {
    throw new Error(
      `Agent "${request.agent}" allows at most ${policy.maxConstraintsChars} total constraint characters by broker policy.`
    );
  }

  if (request.apply && !capabilities.supportsApply) {
    throw new Error(`Agent "${request.agent}" does not support apply=true.`);
  }

  if (request.apply && !policy.allowApply) {
    throw new Error(`Agent "${request.agent}" is disabled for apply=true by broker policy.`);
  }

  if (request.apply && policy.requireApplyApproval && !request.apply_approved) {
    throw new Error(
      `Agent "${request.agent}" requires apply_approved=true when apply=true by broker policy.`
    );
  }

  const selectedModel = getSelectedModel(request, capabilities, stateHome);

  if (request.conversation_mode === "stateless") {
    return {
      request,
      canonicalProjectRoot,
      capabilities,
      policy,
      model: selectedModel
    };
  }

  if (!capabilities.supportsResume) {
    throw new Error(`Agent "${request.agent}" does not support resumable conversations.`);
  }

  if (request.conversation_mode === "continue") {
    const conversationId = request.conversation_id!;
    const existingConversation = await getConversationRecord(conversationId, stateHome);

    if (!existingConversation) {
      throw new Error(`No conversation found for conversation_id "${conversationId}".`);
    }

    if (existingConversation.agent !== request.agent) {
      throw new Error(
        `Conversation "${conversationId}" belongs to agent "${existingConversation.agent}", not "${request.agent}".`
      );
    }

    if (existingConversation.project_root !== canonicalProjectRoot) {
      throw new Error(`Conversation "${conversationId}" belongs to a different project_root.`);
    }

    if (request.model && request.model !== existingConversation.model) {
      throw new Error(
        `Conversation "${conversationId}" is pinned to model "${existingConversation.model}", not "${request.model}".`
      );
    }

    return {
      request: {
        ...request,
        project_root: canonicalProjectRoot,
        conversation_id: conversationId,
        model: existingConversation.model
      },
      canonicalProjectRoot,
      capabilities,
      policy,
      model: existingConversation.model,
      conversationId,
      conversationRecord: existingConversation
    };
  }

  const draftConversation = createConversationRecordForNewRequest(
    request,
    canonicalProjectRoot,
    selectedModel,
    stateHome,
    getConversationTimestamp(context)
  );
  const existingConversation = await getConversationRecord(draftConversation.conversation_id, stateHome);

  if (existingConversation) {
    throw new Error(
      `Conversation "${draftConversation.conversation_id}" already exists. Use conversation_mode="continue" instead.`
    );
  }

  return {
    request: {
      ...request,
      project_root: canonicalProjectRoot,
      conversation_id: draftConversation.conversation_id,
      model: selectedModel
    },
    canonicalProjectRoot,
    capabilities,
    policy,
    model: selectedModel,
    conversationId: draftConversation.conversation_id,
    newConversationRecord: draftConversation
  };
}

export async function executePreparedAskAgent(
  prepared: PreparedAskAgentStartRequest,
  context?: ExecuteContext
): Promise<AskAgentExecutionResult> {
  const adapter = getAgentAdapter(prepared.request.agent);
  const now = getConversationTimestamp(context);

  try {
    const execution = await adapter.execute(prepared, context);
    const result = execution.result;

    if (prepared.newConversationRecord) {
      const providerSessionHandle = execution.providerSessionHandle ?? prepared.newConversationRecord.provider_session_handle;

      if (providerSessionHandle.startsWith("pending:")) {
        throw new Error(
          `Agent "${prepared.request.agent}" did not return a resumable session handle for conversation "${prepared.newConversationRecord.conversation_id}".`
        );
      }

      await upsertConversationRecord(
        {
          ...prepared.newConversationRecord,
          provider_session_handle: providerSessionHandle,
          updated_at: toIsoString(now)
        },
        context?.stateHome
      );
    } else if (prepared.conversationRecord) {
      await upsertConversationRecord(
        {
          ...prepared.conversationRecord,
          ...(execution.providerSessionHandle ? { provider_session_handle: execution.providerSessionHandle } : {}),
          updated_at: toIsoString(now)
        },
        context?.stateHome
      );
    }

    return result;
  } catch (error) {
    if (prepared.newConversationRecord) {
      await removeConversationRecord(prepared.newConversationRecord.conversation_id, context?.stateHome).catch(
        () => undefined
      );
    }

    throw error;
  }
}

export async function executeAskAgent(
  rawInput: z.input<typeof askAgentStartRequestSchema>,
  context?: ExecuteContext
): Promise<AskAgentExecutionResult> {
  const prepared = await prepareAskAgentStartRequest(rawInput, context);
  return executePreparedAskAgent(prepared, context);
}

export function listAgents(): ListAgentsOutput {
  return listAgentsOutputSchema.parse({
    agents: [geminiAdapter.capabilities, claudeAdapter.capabilities, codexAdapter.capabilities].map((capabilities) => {
      const policy = getAgentPolicy(capabilities.agent);

      return {
        agent: capabilities.agent,
        enabled: policy.enabled,
        default_model: policy.defaultModel,
        ...(policy.allowedModels === undefined ? {} : { allowed_models: policy.allowedModels }),
        ...(policy.allowedProjectRoots === undefined ? {} : { allowed_project_roots: policy.allowedProjectRoots }),
        allowed_conversation_modes: policy.allowedConversationModes,
        allowed_modes: policy.allowedModes,
        allow_apply: policy.allowApply,
        require_apply_approval: policy.requireApplyApproval,
        max_files: policy.maxFiles,
        ...(policy.maxTaskChars === undefined ? {} : { max_task_chars: policy.maxTaskChars }),
        ...(policy.maxConstraintsChars === undefined
          ? {}
          : { max_constraints_chars: policy.maxConstraintsChars }),
        ...(policy.timeoutMs === undefined ? {} : { timeout_ms: policy.timeoutMs }),
        ...(policy.maxPollAttempts === undefined ? {} : { max_poll_attempts: policy.maxPollAttempts }),
        supports_model_override: capabilities.supportsModelOverride,
        supports_resume: capabilities.supportsResume,
        supports_headless: capabilities.supportsHeadless,
        supports_patch: capabilities.supportsPatch,
        supports_apply: capabilities.supportsApply,
        supports_session_export: capabilities.supportsSessionExport
      };
    })
  });
}

export async function listConversations(stateHome?: string): Promise<ListConversationsOutput> {
  await cleanupExpiredConversations(stateHome);
  const conversations = await listConversationRecords(stateHome);

  return listConversationsOutputSchema.parse({
    conversations: conversations.map((conversation) => ({
      conversation_id: conversation.conversation_id,
      agent: conversation.agent,
      project_root: conversation.project_root,
      model: conversation.model,
      created_at: conversation.created_at,
      updated_at: conversation.updated_at
    }))
  });
}

export async function deleteConversation(
  rawInput: z.input<typeof deleteConversationInputSchema>,
  stateHome?: string
): Promise<DeleteConversationOutput> {
  const input = deleteConversationInputSchema.parse(rawInput);
  const conversation = await getConversationRecord(input.conversation_id, stateHome);

  if (!conversation) {
    return deleteConversationOutputSchema.parse({
      conversation_id: input.conversation_id,
      deleted: false,
      removed_profile: false
    });
  }
  const deletion = await deleteConversationRecordInternal(conversation, stateHome);

  return deleteConversationOutputSchema.parse({
    conversation_id: input.conversation_id,
    deleted: true,
    removed_profile: deletion.removedProfile
  });
}

export async function clearBrokerStateForTests(stateHome?: string): Promise<void> {
  await saveBrokerState(createDefaultBrokerState(), stateHome);
}
