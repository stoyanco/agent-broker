import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as z from "zod/v4";
import {
  askGeminiOutputSchema,
  buildPromptBody,
  DEFAULT_TIMEOUT_MS,
  loadProjectFiles,
  MAX_CONTEXT_CHARS,
  parseAssistantResponsePayload,
  systemPrompt
} from "./bridge.js";

export const DEFAULT_CODEX_MODEL = "gpt-5.4";

export interface CodexCliOptions {
  command?: string;
  preArgs?: string[];
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  model?: string;
  sessionId?: string;
  resumeSessionId?: string;
  ephemeral?: boolean;
}

export interface ExecuteAskCodexOptions {
  codexCli?: CodexCliOptions;
}

const codexJsonlEventSchema = z
  .object({
    type: z.string().trim().min(1),
    thread_id: z.string().trim().min(1).optional(),
    item: z
      .object({
        id: z.string().trim().min(1).optional(),
        type: z.string().trim().min(1),
        text: z.string().optional()
      })
      .optional()
  })
  .passthrough();

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseCodexAssistantPayload(lastAgentMessage: string): z.output<typeof askGeminiOutputSchema> {
  try {
    return parseAssistantResponsePayload(lastAgentMessage, "Codex");
  } catch (error) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lastAgentMessage);
    } catch {
      throw error;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw error;
    }

    const record = parsed as Record<string, unknown>;
    const summary = typeof record.summary === "string" && record.summary.trim().length > 0 ? record.summary.trim() : "";
    const response = typeof record.response === "string" ? record.response.trim() : "";
    const notes = isStringArray(record.notes) ? record.notes.map((note) => note.trim()).filter(Boolean) : [];
    const warnings = isStringArray(record.warnings) ? record.warnings.map((warning) => warning.trim()).filter(Boolean) : [];

    if (isStringArray(record.files)) {
      warnings.push("Codex returned file references instead of the expected files object, so the broker discarded them.");
    }

    return askGeminiOutputSchema.parse({
      summary: summary || response || "Codex returned a normalized consult response.",
      response,
      patches: [],
      files: {},
      notes,
      warnings
    });
  }
}

function shouldUseWindowsCommandShim(command: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

function resolveCodexLaunch(options: CodexCliOptions): { command: string; args: string[] } {
  const requestedCommand = options.command ?? process.env.CODEX_BIN;
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
      args: ["/d", "/s", "/c", "codex", ...preArgs]
    };
  }

  return {
    command: "codex",
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

export function resolveCodexModel(options: { model?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const env = options.env ?? process.env;
  const candidates = [options.model, env.CODEX_BRIDGE_MODEL, env.CODEX_MODEL, DEFAULT_CODEX_MODEL];
  return candidates.find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)!;
}

export function parseCodexExecOutput(stdout: string, lastMessage = ""): {
  output: z.output<typeof askGeminiOutputSchema>;
  threadId?: string;
} {
  const trimmedStdout = stdout.trim();
  let threadId: string | undefined;
  let lastAgentMessage = lastMessage.trim();

  if (trimmedStdout.length > 0) {
    for (const line of trimmedStdout.split(/\r?\n/)) {
      const trimmedLine = line.trim();
      if (trimmedLine.length === 0) {
        continue;
      }

      let parsedEvent: unknown;
      try {
        parsedEvent = JSON.parse(trimmedLine);
      } catch {
        throw new Error("Codex CLI did not return valid JSONL.");
      }

      const event = codexJsonlEventSchema.parse(parsedEvent);

      if (event.type === "thread.started" && event.thread_id) {
        threadId = event.thread_id;
      }

      if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
        lastAgentMessage = event.item.text.trim();
      }
    }
  }

  if (lastAgentMessage.length === 0) {
    throw new Error("Codex CLI did not return a final agent message.");
  }

  return {
    output: parseCodexAssistantPayload(lastAgentMessage),
    threadId
  };
}

export async function executeAskCodex(
  rawInput: {
    task: string;
    project_root: string;
    files?: string[];
    constraints?: string[];
    mode?: "consult" | "review" | "patch" | "rewrite";
    apply?: boolean;
  },
  options: ExecuteAskCodexOptions = {}
): Promise<{ result: z.output<typeof askGeminiOutputSchema>; threadId?: string }> {
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
    targetAgentLabel: "Codex"
  });

  if (promptBody.length > MAX_CONTEXT_CHARS) {
    throw new Error(
      `Request exceeds the ${MAX_CONTEXT_CHARS.toLocaleString()} character safety limit for this MVP. Reduce the task/constraints size or request fewer files.`
    );
  }

  const cliOptions = options.codexCli ?? {};
  const launch = resolveCodexLaunch(cliOptions);
  const envTimeoutMs = Number.parseInt(process.env.CODEX_BRIDGE_TIMEOUT_MS ?? "", 10);
  const timeoutMs = cliOptions.timeoutMs ?? (Number.isFinite(envTimeoutMs) ? envTimeoutMs : DEFAULT_TIMEOUT_MS);
  const model = resolveCodexModel({
    model: cliOptions.model,
    env: cliOptions.env ?? process.env
  });
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-broker-codex-"));
  const lastMessagePath = path.join(tempDir, "last-message.txt");
  const args = [...launch.args, "exec"];
  const promptPayload = [
    systemPrompt,
    promptBody,
    "Return only valid JSON.",
    'Use exact types: "patches" must be an array of { "path", "unified_diff" } objects, "files" must be an object mapping relative file paths to full file contents, and "notes"/"warnings" must be string arrays.',
    'If there are no patches, return "patches": []. If there are no file rewrites, return "files": {}.'
  ].join("\n\n");

  if (cliOptions.resumeSessionId) {
    args.push("resume");
  }

  args.push("--json", "--skip-git-repo-check", "-o", lastMessagePath);

  if (model) {
    args.push("--model", model);
  }

  if (!cliOptions.resumeSessionId) {
    args.push("-C", input.project_root);
    if (cliOptions.ephemeral) {
      args.push("--ephemeral");
    }
  }

  if (cliOptions.resumeSessionId) {
    args.push(cliOptions.resumeSessionId);
  }

  args.push("-");

  try {
    return await new Promise<{ result: z.output<typeof askGeminiOutputSchema>; threadId?: string }>((resolve, reject) => {
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
        reject(new Error(`Failed to start Codex CLI: ${error.message}`));
      });

      child.stdin.write(promptPayload);
      child.stdin.end();

      child.on("close", async (code, signal) => {
        clearTimeout(timer);

        if (timedOut) {
          reject(new Error(`Codex CLI timed out after ${timeoutMs}ms.`));
          return;
        }

        if (code !== 0) {
          const detail = stderr.trim() || stdout.trim() || `signal=${signal ?? "unknown"}`;
          reject(new Error(`Codex CLI exited with code ${code}: ${detail}`));
          return;
        }

        try {
          const lastMessage = await readFile(lastMessagePath, "utf8").catch(() => "");
          const parsed = parseCodexExecOutput(stdout, lastMessage);
          resolve({
            result: parsed.output,
            threadId: parsed.threadId
          });
        } catch (error) {
          reject(error);
        }
      });
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
