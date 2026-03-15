import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, realpath, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as z from "zod/v4";

export const SERVER_NAME = "agent-broker";
export const SERVER_VERSION = "0.4.0";
export const DEFAULT_TIMEOUT_MS = 300_000;
export const MAX_CONTEXT_CHARS = 120_000;
export const DEFAULT_GEMINI_MODEL = "gemini-3.1-pro-preview";
export const DEFAULT_APPROVAL_MODE = "default";
export const GEMINI_PLAIN_TEXT_WARNING = "Gemini returned plain text instead of the expected JSON payload.";
const SINGLE_FILE_SENTINEL = "__REQUESTED_SINGLE_FILE__";
const ISOLATED_GEMINI_HOME_DIRNAME = ".agent-broker";
const ISOLATED_GEMINI_CONFIG_DIRNAME = ".gemini";
const OAUTH_CREDENTIALS_FILENAME = "oauth_creds.json";

const allowedTopLevelDirectories = new Set([
  "src",
  "app",
  "components",
  "pages",
  "styles",
  "lib",
  "server",
  "client",
  "shared",
  "tests",
  "docs",
  "scripts",
  "config",
  ".github"
]);
const allowedExtensions = new Set([
  ".tsx",
  ".ts",
  ".jsx",
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".scss",
  ".html",
  ".md",
  ".mdx",
  ".txt",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".xml",
  ".sh",
  ".ps1",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".rb",
  ".php",
  ".sql"
]);
const allowedRootFiles = new Set([
  "AGENTS.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "RELEASE.md",
  "SECURITY.md",
  "package.json",
  "tsconfig.json",
  "tsconfig.build.json",
  ".gitignore"
]);
const blockedExactFiles = new Set([
  ".env",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb"
]);
const blockedDirectories = new Set(["node_modules", "dist", "build", ".next", ".turbo", "coverage", "out", ".git"]);

export const geminiModeSchema = z.enum(["consult", "review", "patch", "rewrite"]);
export const geminiPatchSchema = z.object({
  path: z.string().trim().min(1),
  unified_diff: z.string().trim().min(1)
});

export const askGeminiInputSchema = z
  .object({
    task: z.string().trim().min(1),
    project_root: z.string().trim().min(1),
    files: z.array(z.string().trim().min(1)).max(8).default([]),
    constraints: z.array(z.string().trim().min(1)).default([]),
    mode: geminiModeSchema.default("consult"),
    apply: z.boolean().default(false)
  })
  .superRefine((input, ctx) => {
    const requiresFiles = input.mode === "patch" || input.mode === "rewrite";
    const normalizedFiles = input.files.map((file) => file.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, ""));
    const seenFiles = new Set<string>();

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

    for (const file of normalizedFiles) {
      if (seenFiles.has(file)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate file entries are not allowed: "${file}".`
        });
        break;
      }

      seenFiles.add(file);
    }
  });

export const askGeminiOutputSchema = z.object({
  summary: z.string().trim().min(1),
  response: z.string().default(""),
  patches: z.array(geminiPatchSchema).default([]),
  files: z.record(z.string(), z.string()).default({}),
  notes: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  applied: z.boolean().default(false),
  applied_files: z.array(z.string()).default([])
});

const geminiEnvelopeSchema = z.object({
  response: z.string().optional(),
  error: z.unknown().optional(),
  stats: z.unknown().optional()
});

export type GeminiMode = z.output<typeof geminiModeSchema>;
export type AskGeminiInput = z.input<typeof askGeminiInputSchema>;
export type AskGeminiOutput = z.output<typeof askGeminiOutputSchema>;
type GeminiRawRunner = (promptHeader: string, promptBody: string) => Promise<string>;

export interface ValidatedProjectFile {
  requestedPath: string;
  normalizedPath: string;
  absolutePath: string;
  content: string;
}

export interface GeminiCliOptions {
  command?: string;
  preArgs?: string[];
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  model?: string;
  profileHome?: string;
  resumeSession?: string;
}

export interface ExecuteAskGeminiOptions {
  runner?: GeminiRunner;
  geminiCli?: GeminiCliOptions;
}

export type GeminiRunner = (promptHeader: string, promptBody: string) => Promise<AskGeminiOutput>;

export interface PreparedGeminiEnvironmentOptions {
  baseEnv?: NodeJS.ProcessEnv;
  model?: string;
  sourceHome?: string;
  profileHome?: string;
}

type BriefFieldKey =
  | "audience"
  | "approvedFacts"
  | "forbiddenClaims"
  | "requiredSections"
  | "tone"
  | "ctaText"
  | "preserveCopy";

interface ParsedBriefConstraints {
  audience: string[];
  approvedFacts: string[];
  forbiddenClaims: string[];
  requiredSections: string[];
  tone: string[];
  ctaText: string[];
  preserveCopy: string[];
  extraConstraints: string[];
}

interface ContentLineInfo {
  lines: string[];
  hadTrailingNewline: boolean;
  lineEnding: "\n" | "\r\n";
}

const constraintPrefixes: Array<{ key: BriefFieldKey; pattern: RegExp }> = [
  { key: "audience", pattern: /^audience\s*:\s*/i },
  { key: "approvedFacts", pattern: /^(approved facts|facts|allowed facts)\s*:\s*/i },
  { key: "forbiddenClaims", pattern: /^(forbidden claims|forbidden claim|do not claim|dont claim)\s*:\s*/i },
  { key: "requiredSections", pattern: /^(required sections|sections|include sections)\s*:\s*/i },
  { key: "tone", pattern: /^tone\s*:\s*/i },
  { key: "ctaText", pattern: /^(cta|cta text|button text)\s*:\s*/i },
  { key: "preserveCopy", pattern: /^(preserve|preserve copy|keep copy|must preserve)\s*:\s*/i }
];

function shouldUseWindowsCommandShim(command: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

export function resolveGeminiLaunch(options: GeminiCliOptions): { command: string; args: string[] } {
  const requestedCommand = options.command ?? process.env.GEMINI_BIN;
  const preArgs = options.preArgs ?? [];

  if (requestedCommand) {
    if (shouldUseWindowsCommandShim(requestedCommand)) {
      return {
        command: process.env.ComSpec ?? "cmd.exe",
        args: ["/d", "/s", "/c", requestedCommand, ...preArgs]
      };
    }

    return { command: requestedCommand, args: preArgs };
  }

  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", "gemini", ...preArgs]
    };
  }

  return {
    command: "gemini",
    args: preArgs
  };
}

export function resolveGeminiModel(options: { model?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const env = options.env ?? process.env;
  const candidates = [options.model, env.GEMINI_BRIDGE_MODEL, env.GEMINI_MODEL, DEFAULT_GEMINI_MODEL];
  return candidates.find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)!;
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

function createIsolatedSettingsPayload(model: string): string {
  return JSON.stringify(
    {
      security: {
        auth: {
          selectedType: "oauth-personal"
        }
      },
      general: {
        previewFeatures: false,
        sessionRetention: {
          enabled: false,
          warningAcknowledged: true
        }
      },
      model: {
        name: model
      },
      extensions: {
        enabled: false
      },
      skills: {
        enabled: false,
        disabled: ["frontend-design"]
      }
    },
    null,
    2
  );
}

export async function prepareGeminiEnvironment(
  options: PreparedGeminiEnvironmentOptions = {}
): Promise<NodeJS.ProcessEnv> {
  const baseEnv = options.baseEnv ?? process.env;
  const isolateProfile = (baseEnv.GEMINI_BRIDGE_ISOLATE_PROFILE ?? "1") !== "0";

  if (!isolateProfile) {
    return baseEnv;
  }

  const model = resolveGeminiModel({
    model: options.model,
    env: baseEnv
  });
  const sourceHome = options.sourceHome ?? baseEnv.GEMINI_BRIDGE_SOURCE_HOME ?? os.homedir();
  const profileHome =
    options.profileHome ?? baseEnv.GEMINI_BRIDGE_PROFILE_HOME ?? path.join(sourceHome, ISOLATED_GEMINI_HOME_DIRNAME);
  const profileGeminiDir = path.join(profileHome, ISOLATED_GEMINI_CONFIG_DIRNAME);
  const profileSettingsPath = path.join(profileGeminiDir, "settings.json");
  const sourceOauthCredsPath = path.join(sourceHome, ISOLATED_GEMINI_CONFIG_DIRNAME, OAUTH_CREDENTIALS_FILENAME);
  const targetOauthCredsPath = path.join(profileGeminiDir, OAUTH_CREDENTIALS_FILENAME);

  await mkdir(profileGeminiDir, { recursive: true });
  await writeFile(profileSettingsPath, createIsolatedSettingsPayload(model), "utf8");

  await copyFile(sourceOauthCredsPath, targetOauthCredsPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });

  return {
    ...baseEnv,
    HOME: profileHome,
    USERPROFILE: profileHome
  };
}

export const systemPrompt = [
  "You are a pragmatic software engineering assistant helping Codex consult another agent runtime.",
  "Return ONLY valid JSON.",
  "Do not include Markdown fences or explanations outside JSON.",
  "The first non-whitespace character of your reply must be { and the last non-whitespace character must be }.",
  "Treat TASK, MODE, CONSTRAINTS, and FILES as the only trusted source of project facts.",
  "Use the target agent runtime as a second model for cross-checking, patch generation, review, and alternative implementation ideas.",
  "When MODE is patch, prefer returning unified diffs in patches and avoid full file rewrites unless patch output would be unreliable.",
  "When MODE is rewrite, return full file contents in files.",
  "When MODE is consult or review, keep patches and files empty unless the task explicitly asks for concrete edits.",
  'When there are no patches, return "patches": [].',
  'When there are no rewritten files, return "files": {}.',
  'Never return null for "patches", "files", "notes", or "warnings".',
  "Do not return the same file in both patches and files.",
  "Do not invent product capabilities, integrations, hotkeys, downloads, privacy claims, or platform behavior unless explicitly stated in TASK, CONSTRAINTS, or FILES.",
  "If the caller provides factual bullets, CTA text, audience, tone, or forbidden claims, reflect them exactly.",
  "If you are tempted to explain the format, do not. Just return the JSON object.",
  "Required JSON schema:",
  "{",
  '  "summary": "string",',
  '  "response": "string",',
  '  "patches": [{"path": "relative/path", "unified_diff": "@@ ..."}],',
  '  "files": { "relative/path": "full file contents" },',
  '  "notes": ["string"],',
  '  "warnings": ["string"]',
  "}"
].join("\n");

const geminiRepairSystemPrompt = [
  "You are a JSON repair formatter for Agent Broker.",
  "Return ONLY valid JSON.",
  "Do not add markdown fences or any explanation.",
  "Do not add new claims, edits, files, or patches that were not already present in the original response.",
  "Preserve the original meaning as closely as possible.",
  'Always return these keys with exact types: "summary" string, "response" string, "patches" array, "files" object, "notes" array, "warnings" array.',
  'Use [] and {} for empty collections. Never return null.'
].join("\n");

function createEmptyParsedBriefConstraints(): ParsedBriefConstraints {
  return {
    audience: [],
    approvedFacts: [],
    forbiddenClaims: [],
    requiredSections: [],
    tone: [],
    ctaText: [],
    preserveCopy: [],
    extraConstraints: []
  };
}

function splitConstraintValue(value: string): string[] {
  return value
    .split(/\s*[|;,]\s*/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseBriefConstraints(constraints: readonly string[]): ParsedBriefConstraints {
  const parsed = createEmptyParsedBriefConstraints();

  for (const constraint of constraints) {
    let matched = false;

    for (const { key, pattern } of constraintPrefixes) {
      if (!pattern.test(constraint)) {
        continue;
      }

      const cleaned = constraint.replace(pattern, "").trim();
      const values = cleaned.length > 0 ? splitConstraintValue(cleaned) : [];
      if (values.length > 0) {
        parsed[key].push(...values);
      }
      matched = true;
      break;
    }

    if (!matched) {
      parsed.extraConstraints.push(constraint);
    }
  }

  return parsed;
}

function formatBriefSection(title: string, values: readonly string[], emptyFallback: string): string {
  if (values.length === 0) {
    return `${title}:\n- ${emptyFallback}`;
  }

  return `${title}:\n${values.map((item) => `- ${item}`).join("\n")}`;
}

function getModeExpectations(mode: GeminiMode): string {
  switch (mode) {
    case "consult":
      return [
        "- Provide advice, alternatives, tradeoffs, or implementation guidance.",
        "- Leave patches and files empty unless the task explicitly requests a concrete edit artifact."
      ].join("\n");
    case "review":
      return [
        "- Focus on bugs, risks, regressions, and missing validation.",
        "- Use response for findings and leave patches/files empty unless the caller asks for a suggested fix artifact."
      ].join("\n");
    case "patch":
      return [
        "- Prefer patches with unified diffs for each changed file.",
        "- Use files only if a reliable patch would be too brittle."
      ].join("\n");
    case "rewrite":
      return [
        "- Return full file contents in files for every changed file.",
        "- Keep patches empty unless the task explicitly asks for both."
      ].join("\n");
  }
}

export function debugLog(message: string, details?: unknown): void {
  if (process.env.DEBUG !== "1") {
    return;
  }

  const suffix = details === undefined ? "" : ` ${typeof details === "string" ? details : JSON.stringify(details)}`;
  console.error(`[agent-broker] ${message}${suffix}`);
}

export function normalizeRelativePath(inputPath: string): string {
  const normalized = inputPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);

  if (parts.length === 0) {
    throw new Error(`Invalid file path "${inputPath}".`);
  }

  if (parts.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Path traversal is not allowed: "${inputPath}".`);
  }

  return parts.join("/");
}

function isWithinDirectory(rootPath: string, candidatePath: string): boolean {
  const rootWithSeparator = rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`;
  return candidatePath === rootPath || candidatePath.startsWith(rootWithSeparator);
}

function assertAllowedRelativePath(normalizedPath: string): void {
  const segments = normalizedPath.split("/");
  const [topLevelDirectory] = segments;
  const extension = path.extname(normalizedPath).toLowerCase();
  const baseName = path.posix.basename(normalizedPath).toLowerCase();
  const isRootFile = segments.length === 1;

  if (isRootFile) {
    if (!allowedRootFiles.has(segments[0]) && !allowedExtensions.has(extension)) {
      throw new Error(`Root file "${normalizedPath}" is not allowed by the safety policy.`);
    }
  } else if (!allowedTopLevelDirectories.has(topLevelDirectory)) {
    throw new Error(
      `File "${normalizedPath}" must live under one of: ${Array.from(allowedTopLevelDirectories).join(", ")}.`
    );
  }

  if (!isRootFile && !allowedExtensions.has(extension)) {
    throw new Error(`File "${normalizedPath}" has unsupported extension "${extension}".`);
  }

  if (blockedExactFiles.has(baseName) || baseName.startsWith(".env")) {
    throw new Error(`File "${normalizedPath}" is blocked by the safety policy.`);
  }

  if (segments.some((segment) => blockedDirectories.has(segment.toLowerCase()))) {
    throw new Error(`File "${normalizedPath}" targets a blocked directory.`);
  }
}

export async function loadProjectFiles(input: AskGeminiInput): Promise<ValidatedProjectFile[]> {
  if (!path.isAbsolute(input.project_root)) {
    throw new Error("project_root must be an absolute path.");
  }

  const projectRoot = await realpath(input.project_root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new Error(`project_root does not exist: "${input.project_root}".`);
    }

    throw error;
  });
  const projectRootStats = await stat(projectRoot);

  if (!projectRootStats.isDirectory()) {
    throw new Error(`project_root must point to a directory: "${input.project_root}".`);
  }

  const validatedFiles: ValidatedProjectFile[] = [];

  for (const requestedPath of input.files ?? []) {
    if (path.isAbsolute(requestedPath)) {
      throw new Error(`File "${requestedPath}" must be relative to project_root.`);
    }

    const normalizedPath = normalizeRelativePath(requestedPath);
    assertAllowedRelativePath(normalizedPath);

    const joinedPath = path.resolve(projectRoot, normalizedPath);
    const canonicalPath = await realpath(joinedPath).catch(() => {
      throw new Error(`File "${normalizedPath}" does not exist.`);
    });

    if (!isWithinDirectory(projectRoot, canonicalPath)) {
      throw new Error(`File "${normalizedPath}" resolves outside project_root.`);
    }

    const content = await readFile(canonicalPath, "utf8");
    validatedFiles.push({
      requestedPath,
      normalizedPath,
      absolutePath: canonicalPath,
      content
    });
  }

  return validatedFiles;
}

function getFenceLanguage(normalizedPath: string): string {
  const extension = path.extname(normalizedPath).toLowerCase();

  switch (extension) {
    case ".tsx":
      return "tsx";
    case ".ts":
      return "ts";
    case ".jsx":
      return "jsx";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "js";
    case ".css":
      return "css";
    case ".scss":
      return "scss";
    case ".html":
      return "html";
    case ".md":
    case ".mdx":
      return "md";
    case ".json":
      return "json";
    case ".yml":
    case ".yaml":
      return "yaml";
    case ".toml":
      return "toml";
    case ".sh":
      return "sh";
    case ".ps1":
      return "powershell";
    case ".py":
      return "python";
    default:
      return "text";
  }
}

export function buildPromptBody(
  input: AskGeminiInput,
  files: ValidatedProjectFile[],
  options: { targetAgentLabel?: string } = {}
): string {
  const targetAgentLabel = options.targetAgentLabel ?? "Gemini";
  const brief = parseBriefConstraints(input.constraints ?? []);
  const constraintSection =
    brief.extraConstraints.length === 0 ? "- none provided" : brief.extraConstraints.map((item) => `- ${item}`).join("\n");
  const targetFiles =
    files.length === 0 ? "- no files provided" : files.map((file) => `- ${file.normalizedPath}`).join("\n");
  const fileSections =
    files.length === 0
      ? "No file contents were attached."
      : files
          .map((file) => {
            const language = getFenceLanguage(file.normalizedPath);
            return `FILE: ${file.normalizedPath}\n\`\`\`${language}\n${file.content}\n\`\`\``;
          })
          .join("\n\n");

  return [
    `TASK:\n${input.task}`,
    `MODE:\n${input.mode ?? "consult"}`,
    `MODE_EXPECTATIONS:\n${getModeExpectations(input.mode ?? "consult")}`,
    `CALLER_EXPECTATIONS:\n- The host agent is the primary orchestrator.\n- ${targetAgentLabel} is the consulted runtime used for consultation, review, patch generation, or rewrite assistance.\n- Keep output grounded in the provided files and constraints.`,
    `OUTPUT_REQUIREMENTS:\n- Return exactly one JSON object.\n- No markdown fences.\n- No prose before or after the JSON object.\n- "summary" and "response" must always be strings.\n- "patches", "notes", and "warnings" must always be arrays.\n- "files" must always be an object.\n- Use [] and {} for empty collections, never null.\n- For consult/review with no concrete edits, return "patches": [] and "files": {}.`,
    formatBriefSection("AUDIENCE", brief.audience, "not provided"),
    formatBriefSection("APPROVED_FACTS", brief.approvedFacts, "use only facts already present in the source files"),
    formatBriefSection("FORBIDDEN_CLAIMS", brief.forbiddenClaims, "do not invent product claims beyond the provided facts"),
    formatBriefSection(
      "REQUIRED_SECTIONS",
      brief.requiredSections,
      "preserve the current structure unless the task asks for a different one"
    ),
    formatBriefSection("TONE", brief.tone, "keep the tone practical and conservative"),
    formatBriefSection("CTA_TEXT", brief.ctaText, "preserve existing CTA text unless the caller explicitly changes it"),
    formatBriefSection("PRESERVE_COPY", brief.preserveCopy, "preserve existing factual copy where possible"),
    `EXTRA_CONSTRAINTS:\n${constraintSection}`,
    `TARGET_FILES:\n${targetFiles}`,
    `PROJECT_ROOT:\n${input.project_root}`,
    `FILES:\n${fileSections}`
  ].join("\n\n");
}

export function stripJsonFence(rawResponse: string): string {
  const trimmed = rawResponse.trim();
  const exactFenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (exactFenceMatch) {
    return exactFenceMatch[1].trim();
  }

  const embeddedFenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return embeddedFenceMatch ? embeddedFenceMatch[1].trim() : trimmed;
}

function parseMarkdownFilePayload(rawResponse: string): AskGeminiOutput | null {
  const fileBlockPattern = /###\s+`([^`]+)`\s*```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```/g;
  const files: Record<string, string> = {};
  let match: RegExpExecArray | null;

  while ((match = fileBlockPattern.exec(rawResponse)) !== null) {
    files[match[1]] = match[2];
  }

  if (Object.keys(files).length === 0) {
    return null;
  }

  const summarySection = rawResponse.split(/^###\s+`/m)[0].trim();
  const summary = summarySection
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("```"))
    .join(" ")
    .replace(/^Here are the full file contents to\s*/i, "")
    .trim();

  return {
    summary: summary || "Generated updated file contents.",
    response: "",
    patches: [],
    files,
    notes: [],
    warnings: [],
    applied: false,
    applied_files: []
  };
}

function summarizeResponseText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();

  if (collapsed.length === 0) {
    return "Gemini returned a text response.";
  }

  return collapsed.length <= 120 ? collapsed : `${collapsed.slice(0, 117).trimEnd()}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function coerceStringRecord(value: unknown): Record<string, string> | null {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    return null;
  }

  const normalizedEntries: Array<readonly [string, string]> = [];

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      return null;
    }

    normalizedEntries.push([key, entry] as const);
  }

  return Object.fromEntries(normalizedEntries);
}

function coercePatchArray(value: unknown): AskGeminiOutput["patches"] | null {
  if (!Array.isArray(value)) {
    return [];
  }

  const parsed = z.array(geminiPatchSchema).safeParse(value);
  return parsed.success ? parsed.data : null;
}

function createTextOnlyOutput(response: string, summary?: string, warning?: string): AskGeminiOutput {
  const normalizedResponse = response.trim();
  const warnings = warning ? [warning] : [];

  return {
    summary: summary?.trim() || summarizeResponseText(normalizedResponse),
    response: normalizedResponse,
    patches: [],
    files: {},
    notes: [],
    warnings,
    applied: false,
    applied_files: []
  };
}

function coerceJsonPayloadToOutput(parsedInnerJson: unknown, providerLabel = "Provider"): AskGeminiOutput | null {
  if (typeof parsedInnerJson === "string") {
    return createTextOnlyOutput(
      parsedInnerJson,
      undefined,
      `${providerLabel} returned an unstructured JSON string instead of the full bridge schema.`
    );
  }

  if (!isRecord(parsedInnerJson)) {
    return null;
  }

  const summary = typeof parsedInnerJson.summary === "string" ? parsedInnerJson.summary.trim() : "";
  const responseCandidates = [
    parsedInnerJson.response,
    parsedInnerJson.message,
    parsedInnerJson.findings,
    parsedInnerJson.analysis
  ];
  const response = responseCandidates.find((value): value is string => typeof value === "string" && value.trim().length > 0);
  const patches = coercePatchArray(parsedInnerJson.patches);
  const files = coerceStringRecord(parsedInnerJson.files);

  if (patches === null || files === null) {
    return null;
  }

  if (!response && summary.length === 0 && patches.length === 0 && Object.keys(files).length === 0) {
    return null;
  }

  return {
    summary: summary || summarizeResponseText(response ?? ""),
    response: response?.trim() ?? "",
    patches,
    files,
    notes: coerceStringArray(parsedInnerJson.notes),
    warnings: [
      ...coerceStringArray(parsedInnerJson.warnings),
      `${providerLabel} returned a JSON payload outside the strict bridge schema, so the bridge normalized it.`
    ],
    applied: false,
    applied_files: []
  };
}

function parseSingleFencedFilePayload(rawResponse: string): AskGeminiOutput | null {
  const trimmed = rawResponse.trim();
  const withPathMatch = trimmed.match(/```[a-zA-Z0-9_-]*\n(?:\/\/|\/\*)\s*([^\n*]+?)\s*(?:\*\/)?\n([\s\S]*?)\n```/);
  const noPathMatch = trimmed.match(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)\n```/);

  let relativePath: string;
  let content: string;

  if (withPathMatch) {
    relativePath = normalizeRelativePath(withPathMatch[1].trim());
    content = withPathMatch[2];
  } else if (noPathMatch) {
    const language = (noPathMatch[1] ?? "").toLowerCase();
    if (language === "json" || language === "diff" || language === "patch") {
      return null;
    }

    relativePath = SINGLE_FILE_SENTINEL;
    content = noPathMatch[2];
  } else {
    return null;
  }

  return {
    summary: `Generated updated file contents for ${relativePath}.`,
    response: "",
    patches: [],
    files: {
      [relativePath]: content
    },
    notes: [],
    warnings: [],
    applied: false,
    applied_files: []
  };
}

function formatEnvelopeError(envelopeError: unknown): string {
  if (typeof envelopeError === "string") {
    return envelopeError;
  }

  try {
    return JSON.stringify(envelopeError);
  } catch {
    return String(envelopeError);
  }
}

export function parseAssistantResponsePayload(rawResponse: string, providerLabel = "Provider"): AskGeminiOutput {
  const innerJson = stripJsonFence(rawResponse);

  let parsedInnerJson: unknown;
  try {
    parsedInnerJson = JSON.parse(innerJson);
  } catch {
    const markdownFallback = parseMarkdownFilePayload(rawResponse);
    if (markdownFallback) {
      return markdownFallback;
    }

    const singleFenceFallback = parseSingleFencedFilePayload(rawResponse);
    if (singleFenceFallback) {
      return singleFenceFallback;
    }

    if (rawResponse.trim().length > 0) {
      return createTextOnlyOutput(
        rawResponse,
        undefined,
        providerLabel === "Gemini" ? GEMINI_PLAIN_TEXT_WARNING : `${providerLabel} returned plain text instead of the expected JSON payload.`
      );
    }

    throw new Error(`${providerLabel} response payload was not valid JSON.`);
  }

  const parsedOutput = askGeminiOutputSchema.safeParse(parsedInnerJson);
  if (parsedOutput.success) {
    return parsedOutput.data;
  }

  const coercedOutput = coerceJsonPayloadToOutput(parsedInnerJson, providerLabel);
  if (coercedOutput) {
    return coercedOutput;
  }

  throw new Error(`${providerLabel} response payload did not match the expected schema.`);
}

export function parseGeminiCliResponse(stdout: string): AskGeminiOutput {
  return parseAssistantResponsePayload(parseGeminiCliEnvelope(stdout), "Gemini");
}

function parseGeminiCliEnvelope(stdout: string): string {
  let parsedEnvelope: unknown;

  try {
    parsedEnvelope = JSON.parse(stdout);
  } catch {
    throw new Error("Gemini CLI did not return valid JSON.");
  }

  const envelope = geminiEnvelopeSchema.parse(parsedEnvelope);

  if (envelope.error !== undefined && envelope.error !== null) {
    throw new Error(`Gemini CLI returned an error: ${formatEnvelopeError(envelope.error)}`);
  }

  if (typeof envelope.response !== "string" || envelope.response.trim() === "") {
    throw new Error("Gemini CLI JSON output did not include a response payload.");
  }

  return envelope.response;
}

function createGeminiRawRunner(options: GeminiCliOptions = {}): GeminiRawRunner {
  const launch = resolveGeminiLaunch(options);
  const envTimeoutMs = Number.parseInt(process.env.GEMINI_BRIDGE_TIMEOUT_MS ?? "", 10);
  const timeoutMs = options.timeoutMs ?? (Number.isFinite(envTimeoutMs) ? envTimeoutMs : DEFAULT_TIMEOUT_MS);
  const model = resolveGeminiModel({
    model: options.model,
    env: options.env ?? process.env
  });
  const approvalMode = process.env.GEMINI_BRIDGE_APPROVAL_MODE ?? DEFAULT_APPROVAL_MODE;

  return async (promptHeader: string, promptBody: string) => {
    const args = [...launch.args, "--approval-mode", approvalMode, "--output-format", "json"];
    const childEnv = await prepareGeminiEnvironment({
      baseEnv: options.env ?? process.env,
      model,
      profileHome: options.profileHome
    });

    if (model) {
      args.push("--model", model);
    }

    if (options.resumeSession) {
      args.push("--resume", options.resumeSession);
    }

    args.push("--prompt", promptHeader);

    return await new Promise<string>((resolve, reject) => {
      const child = spawn(launch.command, args, {
        cwd: options.cwd,
        env: childEnv,
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
        reject(new Error(`Failed to start Gemini CLI: ${error.message}`));
      });

      child.on("close", (code, signal) => {
        clearTimeout(timer);

        if (timedOut) {
          reject(new Error(`Gemini CLI timed out after ${timeoutMs}ms.`));
          return;
        }

        if (code !== 0) {
          const detail = stderr.trim() || stdout.trim() || `signal=${signal ?? "unknown"}`;
          reject(new Error(`Gemini CLI exited with code ${code}: ${detail}`));
          return;
        }

        try {
          resolve(parseGeminiCliEnvelope(stdout));
        } catch (error) {
          reject(error);
        }
      });

      child.stdin.write(promptBody);
      child.stdin.end();
    });
  };
}

export function createGeminiRunner(options: GeminiCliOptions = {}): GeminiRunner {
  const rawRunner = createGeminiRawRunner(options);

  return async (promptHeader: string, promptBody: string) => {
    const rawResponse = await rawRunner(promptHeader, promptBody);
    return parseAssistantResponsePayload(rawResponse, "Gemini");
  };
}

function shouldAttemptGeminiRepair(output: AskGeminiOutput): boolean {
  return output.warnings.includes(GEMINI_PLAIN_TEXT_WARNING);
}

function buildGeminiRepairPrompt(input: AskGeminiInput, rawResponse: string): string {
  const requestedInputFiles = input.files ?? [];
  const requestedFiles =
    requestedInputFiles.length === 0
      ? "- none"
      : requestedInputFiles.map((file) => `- ${normalizeRelativePath(file)}`).join("\n");

  return [
    "Reformat the original Gemini response into the required JSON object for Agent Broker.",
    "Do not add new facts or edits.",
    "Do not drop meaningful content.",
    'If the original response is just prose, put that prose into "response" and generate a short grounded "summary".',
    'If the original response does not explicitly contain patches or rewritten file contents, return "patches": [] and "files": {}.',
    `MODE:\n${input.mode ?? "consult"}`,
    `REQUESTED_FILES:\n${requestedFiles}`,
    `ORIGINAL_PROVIDER_RESPONSE:\n<<<ORIGINAL_RESPONSE\n${rawResponse.trim()}\nORIGINAL_RESPONSE`
  ].join("\n\n");
}

async function executeAskGeminiWithRepair(
  input: AskGeminiInput,
  options: ExecuteAskGeminiOptions,
  promptBody: string
): Promise<AskGeminiOutput> {
  const rawRunner = createGeminiRawRunner({
    ...options.geminiCli,
    cwd: options.geminiCli?.cwd ?? input.project_root
  });
  const rawResponse = await rawRunner(systemPrompt, promptBody);
  const firstPass = parseAssistantResponsePayload(rawResponse, "Gemini");

  if (!shouldAttemptGeminiRepair(firstPass)) {
    return firstPass;
  }

  try {
    const repairedRawResponse = await rawRunner(geminiRepairSystemPrompt, buildGeminiRepairPrompt(input, rawResponse));
    const repaired = parseAssistantResponsePayload(repairedRawResponse, "Gemini");

    if (!shouldAttemptGeminiRepair(repaired)) {
      return {
        ...repaired,
        notes: [...repaired.notes, "Gemini repair pass normalized an initial plain-text response into the broker schema."]
      };
    }
  } catch {
    // Keep the original normalized plain-text fallback if the repair pass fails.
  }

  return firstPass;
}

function normalizeOutputPath(requestedFiles: readonly string[], returnedPath: string): string {
  if (returnedPath === SINGLE_FILE_SENTINEL && requestedFiles.length === 1) {
    return normalizeRelativePath(requestedFiles[0]);
  }

  return normalizeRelativePath(returnedPath);
}

export function validateResponseArtifacts(requestedFiles: readonly string[], output: AskGeminiOutput): AskGeminiOutput {
  const requestedSet = new Set(requestedFiles.map((file) => normalizeRelativePath(file)));
  const normalizedFiles: Record<string, string> = {};
  const normalizedPatches: AskGeminiOutput["patches"] = [];
  const seenPaths = new Set<string>();

  for (const patch of output.patches) {
    const normalizedPath = normalizeOutputPath(requestedFiles, patch.path);
    assertAllowedRelativePath(normalizedPath);

    if (!requestedSet.has(normalizedPath)) {
      throw new Error(`Gemini returned an unexpected patch target: "${normalizedPath}".`);
    }

    if (seenPaths.has(normalizedPath)) {
      throw new Error(`Gemini returned duplicate edit targets for "${normalizedPath}".`);
    }

    seenPaths.add(normalizedPath);
    normalizedPatches.push({
      path: normalizedPath,
      unified_diff: patch.unified_diff
    });
  }

  for (const [returnedPath, content] of Object.entries(output.files)) {
    const normalizedPath = normalizeOutputPath(requestedFiles, returnedPath);
    assertAllowedRelativePath(normalizedPath);

    if (!requestedSet.has(normalizedPath)) {
      throw new Error(`Gemini returned an unexpected file: "${normalizedPath}".`);
    }

    if (seenPaths.has(normalizedPath)) {
      throw new Error(`Gemini returned both a patch and a file for "${normalizedPath}".`);
    }

    seenPaths.add(normalizedPath);
    normalizedFiles[normalizedPath] = content;
  }

  return {
    summary: output.summary,
    response: output.response,
    patches: normalizedPatches,
    files: normalizedFiles,
    notes: output.notes,
    warnings: output.warnings,
    applied: output.applied,
    applied_files: output.applied_files
  };
}

function splitContentForPatch(content: string): ContentLineInfo {
  const lineEnding: "\n" | "\r\n" = content.includes("\r\n") ? "\r\n" : "\n";
  const normalized = content.replace(/\r\n/g, "\n");
  const hadTrailingNewline = normalized.endsWith("\n");
  const body = hadTrailingNewline ? normalized.slice(0, -1) : normalized;

  return {
    lines: body.length === 0 ? [] : body.split("\n"),
    hadTrailingNewline,
    lineEnding
  };
}

function restorePatchedContent(lineInfo: ContentLineInfo, lines: string[]): string {
  const joined = lines.join("\n");
  const withTrailingNewline = lineInfo.hadTrailingNewline ? `${joined}\n` : joined;
  return lineInfo.lineEnding === "\r\n" ? withTrailingNewline.replace(/\n/g, "\r\n") : withTrailingNewline;
}

export function applyUnifiedDiff(originalContent: string, unifiedDiff: string): string {
  const lineInfo = splitContentForPatch(originalContent);
  const diffLines = unifiedDiff.replace(/\r\n/g, "\n").split("\n");
  const result: string[] = [];
  let readIndex = 0;
  let index = 0;

  while (index < diffLines.length && !diffLines[index].startsWith("@@")) {
    index += 1;
  }

  if (index >= diffLines.length) {
    throw new Error("Unified diff did not include any hunks.");
  }

  while (index < diffLines.length) {
    const header = diffLines[index];
    const match = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);

    if (!match) {
      throw new Error(`Invalid unified diff hunk header: "${header}".`);
    }

    const oldStart = Number.parseInt(match[1], 10);
    const oldCount = Number.parseInt(match[2] ?? "1", 10);
    const newCount = Number.parseInt(match[4] ?? "1", 10);
    const hunkStartIndex = Math.max(0, oldStart - 1);
    let seenOldLines = 0;
    let seenNewLines = 0;

    if (hunkStartIndex < readIndex) {
      throw new Error(`Unified diff hunks overlap or are out of order near line ${oldStart}.`);
    }

    while (readIndex < hunkStartIndex) {
      result.push(lineInfo.lines[readIndex] ?? "");
      readIndex += 1;
    }

    index += 1;

    while (index < diffLines.length && !diffLines[index].startsWith("@@")) {
      const line = diffLines[index];

      if (line === "\\ No newline at end of file") {
        index += 1;
        continue;
      }

      const prefix = line[0];
      const value = line.slice(1);

      if (prefix === " ") {
        if (lineInfo.lines[readIndex] !== value) {
          throw new Error(`Patch context mismatch. Expected "${lineInfo.lines[readIndex] ?? ""}" but saw "${value}".`);
        }

        result.push(lineInfo.lines[readIndex]);
        readIndex += 1;
        seenOldLines += 1;
        seenNewLines += 1;
      } else if (prefix === "-") {
        if (lineInfo.lines[readIndex] !== value) {
          throw new Error(
            `Patch deletion mismatch. Expected "${lineInfo.lines[readIndex] ?? ""}" but saw "${value}".`
          );
        }

        readIndex += 1;
        seenOldLines += 1;
      } else if (prefix === "+") {
        result.push(value);
        seenNewLines += 1;
      } else {
        throw new Error(`Unsupported unified diff line: "${line}".`);
      }

      index += 1;
    }

    if (seenOldLines !== oldCount || seenNewLines !== newCount) {
      throw new Error(
        `Unified diff hunk counts did not match header. Expected -${oldCount} +${newCount}, saw -${seenOldLines} +${seenNewLines}.`
      );
    }
  }

  while (readIndex < lineInfo.lines.length) {
    result.push(lineInfo.lines[readIndex]);
    readIndex += 1;
  }

  return restorePatchedContent(lineInfo, result);
}

export async function applyValidatedArtifacts(
  projectRoot: string,
  patches: readonly z.output<typeof geminiPatchSchema>[],
  files: Record<string, string>
): Promise<string[]> {
  const root = await realpath(projectRoot);
  const nextContents = new Map<string, string>();

  for (const patch of patches) {
    const normalizedPath = normalizeRelativePath(patch.path);
    assertAllowedRelativePath(normalizedPath);
    const absolutePath = path.resolve(root, normalizedPath);

    if (!isWithinDirectory(root, absolutePath)) {
      throw new Error(`Refusing to write outside project_root: "${normalizedPath}".`);
    }

    const currentContent = await readFile(absolutePath, "utf8");
    nextContents.set(normalizedPath, applyUnifiedDiff(currentContent, patch.unified_diff));
  }

  for (const [relativePath, content] of Object.entries(files)) {
    const normalizedPath = normalizeRelativePath(relativePath);
    assertAllowedRelativePath(normalizedPath);
    const absolutePath = path.resolve(root, normalizedPath);

    if (!isWithinDirectory(root, absolutePath)) {
      throw new Error(`Refusing to write outside project_root: "${normalizedPath}".`);
    }

    nextContents.set(normalizedPath, content);
  }

  for (const [relativePath, content] of nextContents.entries()) {
    const absolutePath = path.resolve(root, relativePath);
    await writeFile(absolutePath, content, "utf8");
  }

  return [...nextContents.keys()];
}

export async function executeAskGemini(
  rawInput: AskGeminiInput,
  options: ExecuteAskGeminiOptions = {}
): Promise<AskGeminiOutput> {
  const input = askGeminiInputSchema.parse(rawInput);
  const files = await loadProjectFiles(input);
  const promptBody = buildPromptBody(input, files);

  if (systemPrompt.length + promptBody.length > MAX_CONTEXT_CHARS) {
    const requestedFiles = input.files.length === 0 ? "no attached files" : input.files.join(", ");
    throw new Error(
      `Request exceeds the ${MAX_CONTEXT_CHARS.toLocaleString()} character safety limit for this MVP. Reduce the task/constraints size or request fewer files. Attached files: ${requestedFiles}.`
    );
  }

  debugLog("Dispatching request to Gemini CLI.", {
    mode: input.mode,
    fileCount: files.length,
    promptChars: systemPrompt.length + promptBody.length
  });

  const result =
    options.runner !== undefined
      ? await options.runner(systemPrompt, promptBody)
      : await executeAskGeminiWithRepair(input, options, promptBody);
  const validatedResult = validateResponseArtifacts(input.files ?? [], result);

  if (!input.apply) {
    return {
      ...validatedResult,
      applied: false,
      applied_files: []
    };
  }

  if (validatedResult.patches.length === 0 && Object.keys(validatedResult.files).length === 0) {
    throw new Error(`Gemini did not return any edits to apply for mode="${input.mode}".`);
  }

  const appliedFiles = await applyValidatedArtifacts(input.project_root, validatedResult.patches, validatedResult.files);
  return {
    ...validatedResult,
    applied: true,
    applied_files: appliedFiles
  };
}

export const askGeminiUiInputSchema = askGeminiInputSchema;
export const askGeminiUiOutputSchema = askGeminiOutputSchema;
export type AskGeminiUiInput = AskGeminiInput;
export type AskGeminiUiOutput = AskGeminiOutput;
export interface ExecuteAskGeminiUiOptions extends ExecuteAskGeminiOptions {}
export const validateResponseFiles = validateResponseArtifacts;
export const applyValidatedFiles = applyValidatedArtifacts;
export const executeAskGeminiUi = executeAskGemini;
