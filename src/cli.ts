#!/usr/bin/env node

import { startServer } from "./server.js";

startServer().catch((error) => {
  console.error(`[agent-broker] Fatal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
