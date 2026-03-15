import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const serverName = process.argv[2] ?? "agent-broker";
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entrypoint = path.join(workspaceRoot, "dist", "cli.js");

function runCodex(command) {
  if (process.platform === "win32") {
    const shell = process.env.ComSpec ?? "cmd.exe";
    return execFileSync(shell, ["/d", "/s", "/c", command], {
      cwd: workspaceRoot,
      encoding: "utf8"
    });
  }

  return execFileSync("sh", ["-lc", command], {
    cwd: workspaceRoot,
    encoding: "utf8"
  });
}

const existing = runCodex("codex mcp list");

if (existing.includes(serverName)) {
  console.log(`Codex MCP server "${serverName}" already exists. Remove it first if you want to replace it.`);
  process.exit(0);
}

runCodex(`codex mcp add ${serverName} -- node "${entrypoint}"`);
