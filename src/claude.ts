import { spawn, type ChildProcess } from "node:child_process";
import * as z from "zod/v4";
import {
  askGeminiOutputSchema,
  buildPromptBody,
  DEFAULT_TIMEOUT_MS,
  loadProjectFiles,
  MAX_CONTEXT_CHARS,
  parseAssistantResponsePayload
} from "./bridge.js";

export const DEFAULT_CLAUDE_MODEL = "sonnet";
const DEFAULT_PERMISSION_MODE = "plan";

export interface ClaudeCliOptions {
  command?: string;
  preArgs?: string[];
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  model?: string;
  sessionId?: string;
  resumeSessionId?: string;
  disableSessionPersistence?: boolean;
}

export interface ExecuteAskClaudeOptions {
  claudeCli?: ClaudeCliOptions;
}

const claudeEnvelopeSchema = z.object({
  type: z.string().trim().min(1),
  subtype: z.string().trim().min(1).optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  session_id: z.string().trim().min(1).optional()
});

function shouldUseWindowsCommandShim(command: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

function resolveClaudeLaunch(options: ClaudeCliOptions): { command: string; args: string[] } {
  const requestedCommand = options.command ?? process.env.CLAUDE_BIN;
  const preArgs = options.preArgs ?? [];

  if (requestedCommand) {
    if (shouldUseWindowsCommandShim(requestedCommand)) {
      return {
        command: process.env.ComSpec ?? "cmd.exe",
        args: ["/d", "/s", "/c", requestedCommand, ...preArgs]
      };
    }

    return {
      command: requestedCommand,
      args: preArgs
    };
  }

  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", "claude", ...preArgs]
    };
  }

  return {
    command: "claude",
    args: preArgs
  };
}

function terminateProcessTree(child: ChildProcess): void {
  if (process.platform === "win32" && typeof child.pid === "number") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true
    });

    killer.on("error", () => {
      child.kill();
    });
    return;
  }

  child.kill();
}

export function resolveClaudeModel(options: { model?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const env = options.env ?? process.env;
  const candidates = [options.model, env.CLAUDE_BRIDGE_MODEL, env.CLAUDE_MODEL, DEFAULT_CLAUDE_MODEL];
  return candidates.find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)!;
}

export function parseClaudeCliResponse(stdout: string) {
  let parsedEnvelope: unknown;

  try {
    parsedEnvelope = JSON.parse(stdout);
  } catch {
    throw new Error("Claude CLI did not return valid JSON.");
  }

  const envelope = claudeEnvelopeSchema.parse(parsedEnvelope);

  if (envelope.type !== "result") {
    throw new Error(`Claude CLI returned an unexpected envelope type: "${envelope.type}".`);
  }

  if (envelope.is_error || envelope.subtype?.startsWith("error_")) {
    throw new Error(`Claude CLI returned an error result: ${envelope.subtype ?? "unknown"}.`);
  }

  if (typeof envelope.result !== "string" || envelope.result.trim().length === 0) {
    throw new Error("Claude CLI JSON output did not include a result payload.");
  }

  return parseAssistantResponsePayload(envelope.result, "Claude");
}

export async function executeAskClaude(
  rawInput: {
    task: string;
    project_root: string;
    files?: string[];
    constraints?: string[];
    mode?: "consult" | "review" | "patch" | "rewrite";
    apply?: boolean;
  },
  options: ExecuteAskClaudeOptions = {}
) {
  const input = {
    task: rawInput.task,
    project_root: rawInput.project_root,
    files: rawInput.files ?? [],
    constraints: rawInput.constraints ?? [],
    mode: rawInput.mode ?? "consult",
    apply: rawInput.apply ?? false
  };
  const files = await loadProjectFiles(input);
  const promptBody = buildPromptBody(input, files, {
    targetAgentLabel: "Claude"
  });

  if (promptBody.length > MAX_CONTEXT_CHARS) {
    throw new Error(
      `Request exceeds the ${MAX_CONTEXT_CHARS.toLocaleString()} character safety limit for this MVP. Reduce the task/constraints size or request fewer files.`
    );
  }

  const cliOptions = options.claudeCli ?? {};
  const launch = resolveClaudeLaunch(cliOptions);
  const envTimeoutMs = Number.parseInt(process.env.CLAUDE_BRIDGE_TIMEOUT_MS ?? "", 10);
  const timeoutMs = cliOptions.timeoutMs ?? (Number.isFinite(envTimeoutMs) ? envTimeoutMs : DEFAULT_TIMEOUT_MS);
  const model = resolveClaudeModel({
    model: cliOptions.model,
    env: cliOptions.env ?? process.env
  });
  const permissionMode = process.env.CLAUDE_BRIDGE_PERMISSION_MODE ?? DEFAULT_PERMISSION_MODE;
  const args = [...launch.args, "-p", "--output-format", "json", "--permission-mode", permissionMode, "--tools", ""];

  if (model) {
    args.push("--model", model);
  }

  if (cliOptions.disableSessionPersistence) {
    args.push("--no-session-persistence");
  } else if (cliOptions.resumeSessionId) {
    args.push("--resume", cliOptions.resumeSessionId);
  } else if (cliOptions.sessionId) {
    args.push("--session-id", cliOptions.sessionId);
  }

  args.push("--append-system-prompt", "You are a pragmatic software engineering assistant helping Codex consult another agent runtime.");

  return await new Promise<z.output<typeof askGeminiOutputSchema>>((resolve, reject) => {
    const child = spawn(launch.command, args, {
      cwd: cliOptions.cwd ?? input.project_root,
      env: cliOptions.env ?? process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start Claude CLI: ${error.message}`));
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);

      if (timedOut) {
        reject(new Error(`Claude CLI timed out after ${timeoutMs}ms.`));
        return;
      }

      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || `signal=${signal ?? "unknown"}`;
        reject(new Error(`Claude CLI exited with code ${code}: ${detail}`));
        return;
      }

      try {
        resolve(parseClaudeCliResponse(stdout));
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.write(promptBody);
    child.stdin.end();
  });
}
