import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as z from "zod/v4";
import { DEFAULT_GEMINI_MODEL, geminiModeSchema } from "./bridge.js";
import { DEFAULT_CLAUDE_MODEL } from "./claude.js";
import { DEFAULT_CODEX_MODEL } from "./codex.js";

export const BROKER_CONFIG_ENV = "AGENT_BROKER_CONFIG";
const LEGACY_BROKER_CONFIG_ENV = "CODEX_COUNCIL_CONFIG";
const LEGACY_BROKER_HOME_ENV = "CODEX_COUNCIL_HOME";
const BROKER_CONFIG_FILENAME = "config.json";
const conversationModeSchema = z.enum(["stateless", "new", "continue"]);

const agentPolicySchema = z.object({
  enabled: z.boolean().optional(),
  default_model: z.string().trim().min(1).optional(),
  allowed_models: z.array(z.string().trim().min(1)).nonempty().optional(),
  allowed_project_roots: z
    .array(
      z.string().trim().min(1).refine((value) => path.isAbsolute(value), {
        message: "allowed_project_roots entries must be absolute paths."
      })
    )
    .nonempty()
    .optional(),
  allowed_conversation_modes: z.array(conversationModeSchema).nonempty().optional(),
  allowed_modes: z.array(geminiModeSchema).nonempty().optional(),
  allow_apply: z.boolean().optional(),
  require_apply_approval: z.boolean().optional(),
  max_files: z.number().int().positive().max(8).optional(),
  max_task_chars: z.number().int().positive().optional(),
  max_constraints_chars: z.number().int().positive().optional(),
  timeout_ms: z.number().int().positive().optional(),
  max_poll_attempts: z.number().int().positive().optional()
});

const conversationPolicySchema = z.object({
  max_age_hours: z.number().int().positive().optional()
});

const brokerConfigSchema = z.object({
  version: z.literal(1).default(1),
  agents: z
    .object({
      gemini: agentPolicySchema.optional(),
      claude: agentPolicySchema.optional(),
      codex: agentPolicySchema.optional()
    })
    .default({}),
  conversations: conversationPolicySchema.optional()
});

export type BrokerConfig = z.output<typeof brokerConfigSchema>;
export type BrokerAgentPolicy = z.output<typeof agentPolicySchema>;
export type BrokerConversationPolicy = z.output<typeof conversationPolicySchema>;

export type ResolvedAgentPolicy = {
  enabled: boolean;
  defaultModel: string;
  allowedModels?: string[];
  allowedProjectRoots?: string[];
  allowedConversationModes: Array<z.output<typeof conversationModeSchema>>;
  allowedModes: Array<z.output<typeof geminiModeSchema>>;
  allowApply: boolean;
  requireApplyApproval: boolean;
  maxFiles: number;
  maxTaskChars?: number;
  maxConstraintsChars?: number;
  timeoutMs?: number;
  maxPollAttempts?: number;
};

export type ResolvedConversationPolicy = {
  maxAgeHours?: number;
  maxAgeMs?: number;
};

function getBrokerHome(stateHome?: string): string {
  return (
    stateHome ??
    process.env.AGENT_BROKER_HOME ??
    process.env[LEGACY_BROKER_HOME_ENV] ??
    path.join(os.homedir(), ".agent-broker")
  );
}

export function getBrokerConfigPath(stateHome?: string): string {
  return process.env[BROKER_CONFIG_ENV] ?? process.env[LEGACY_BROKER_CONFIG_ENV] ?? path.join(getBrokerHome(stateHome), BROKER_CONFIG_FILENAME);
}

export function loadBrokerConfig(stateHome?: string): BrokerConfig {
  const configPath = getBrokerConfigPath(stateHome);

  try {
    const raw = readFileSync(configPath, "utf8");
    return brokerConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return brokerConfigSchema.parse({});
    }

    throw error;
  }
}

export function resolveAgentPolicy(agent: "gemini" | "claude" | "codex", config: BrokerConfig): ResolvedAgentPolicy {
  const configuredPolicy = config.agents[agent];

  if (agent === "gemini") {
    return {
      enabled: configuredPolicy?.enabled ?? true,
      defaultModel: configuredPolicy?.default_model ?? DEFAULT_GEMINI_MODEL,
      allowedModels: configuredPolicy?.allowed_models,
      allowedProjectRoots: configuredPolicy?.allowed_project_roots,
      allowedConversationModes: configuredPolicy?.allowed_conversation_modes ?? ["stateless", "new", "continue"],
      allowedModes: configuredPolicy?.allowed_modes ?? ["consult", "review", "patch", "rewrite"],
      allowApply: configuredPolicy?.allow_apply ?? true,
      requireApplyApproval: configuredPolicy?.require_apply_approval ?? false,
      maxFiles: configuredPolicy?.max_files ?? 8,
      maxTaskChars: configuredPolicy?.max_task_chars,
      maxConstraintsChars: configuredPolicy?.max_constraints_chars,
      timeoutMs: configuredPolicy?.timeout_ms,
      maxPollAttempts: configuredPolicy?.max_poll_attempts
    };
  }

  if (agent === "claude") {
    return {
      enabled: configuredPolicy?.enabled ?? true,
      defaultModel: configuredPolicy?.default_model ?? DEFAULT_CLAUDE_MODEL,
      allowedModels: configuredPolicy?.allowed_models,
      allowedProjectRoots: configuredPolicy?.allowed_project_roots,
      allowedConversationModes: configuredPolicy?.allowed_conversation_modes ?? ["stateless", "new", "continue"],
      allowedModes: configuredPolicy?.allowed_modes ?? ["consult", "review"],
      allowApply: configuredPolicy?.allow_apply ?? false,
      requireApplyApproval: configuredPolicy?.require_apply_approval ?? false,
      maxFiles: configuredPolicy?.max_files ?? 8,
      maxTaskChars: configuredPolicy?.max_task_chars,
      maxConstraintsChars: configuredPolicy?.max_constraints_chars,
      timeoutMs: configuredPolicy?.timeout_ms,
      maxPollAttempts: configuredPolicy?.max_poll_attempts
    };
  }

  return {
    enabled: configuredPolicy?.enabled ?? true,
    defaultModel: configuredPolicy?.default_model ?? DEFAULT_CODEX_MODEL,
    allowedModels: configuredPolicy?.allowed_models,
    allowedProjectRoots: configuredPolicy?.allowed_project_roots,
    allowedConversationModes: configuredPolicy?.allowed_conversation_modes ?? ["stateless", "new", "continue"],
    allowedModes: configuredPolicy?.allowed_modes ?? ["consult", "review"],
    allowApply: configuredPolicy?.allow_apply ?? false,
    requireApplyApproval: configuredPolicy?.require_apply_approval ?? false,
    maxFiles: configuredPolicy?.max_files ?? 8,
    maxTaskChars: configuredPolicy?.max_task_chars,
    maxConstraintsChars: configuredPolicy?.max_constraints_chars,
    timeoutMs: configuredPolicy?.timeout_ms,
    maxPollAttempts: configuredPolicy?.max_poll_attempts
  };
}

export function resolveConversationPolicy(config: BrokerConfig): ResolvedConversationPolicy {
  const maxAgeHours = config.conversations?.max_age_hours;

  return {
    maxAgeHours,
    maxAgeMs: maxAgeHours === undefined ? undefined : maxAgeHours * 60 * 60 * 1000
  };
}
