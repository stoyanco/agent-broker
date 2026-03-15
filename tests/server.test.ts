import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  COMPLETED_JOB_TTL_MS,
  cleanupExpiredJobs,
  getOrCreateAgentJob,
  resetAgentJobsForTests,
  waitForAgentJob
} from "../src/server.js";
import { BROKER_HOME_ENV } from "../src/broker.js";

test("waitForAgentJob surfaces async failures without unhandled rejections", async () => {
  resetAgentJobsForTests();

  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandled.push(reason);
  };

  process.on("unhandledRejection", onUnhandledRejection);

  try {
    const job = await getOrCreateAgentJob(
      {
        agent: "gemini",
        task: "Review the code",
        project_root: path.resolve("tests/fixtures/demo-project"),
        files: [],
        constraints: [],
        mode: "review",
        apply: false
      },
      "job-failure",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        throw new Error("boom");
      }
    );

    const firstPoll = await waitForAgentJob(job, 1);
    assert.equal(firstPoll.status, "running");

    await new Promise((resolve) => setTimeout(resolve, 40));
    await assert.rejects(() => waitForAgentJob(job, 1), /boom/);

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
    resetAgentJobsForTests();
  }
});

test("cleanupExpiredJobs removes completed jobs after the TTL", async () => {
  resetAgentJobsForTests();

  const job = await getOrCreateAgentJob(
    {
      agent: "gemini",
      task: "Review the code",
      project_root: path.resolve("tests/fixtures/demo-project"),
      files: [],
      constraints: [],
      mode: "review",
      apply: false
    },
    "job-cleanup",
    async () => ({
      agent: "gemini",
      model: "gemini-3.1-pro-preview",
      summary: "done",
      response: "ok",
      patches: [],
      files: {},
      notes: [],
      warnings: [],
      applied: false,
      applied_files: []
    })
  );

  const completion = await waitForAgentJob(job, 5);
  assert.equal(completion.status, "completed");

  cleanupExpiredJobs((job.completedAt ?? 0) + COMPLETED_JOB_TTL_MS + 1);

  const secondJob = await getOrCreateAgentJob(
    {
      agent: "gemini",
      task: "Review the code",
      project_root: path.resolve("tests/fixtures/demo-project"),
      files: [],
      constraints: [],
      mode: "review",
      apply: false
    },
    "job-cleanup",
    async () => ({
      agent: "gemini",
      model: "gemini-3.1-pro-preview",
      summary: "done again",
      response: "ok",
      patches: [],
      files: {},
      notes: [],
      warnings: [],
      applied: false,
      applied_files: []
    })
  );

  assert.notEqual(secondJob, job);
  resetAgentJobsForTests();
});

test("waitForAgentJob respects broker max_poll_attempts for running jobs", async () => {
  resetAgentJobsForTests();
  const originalBrokerHome = process.env[BROKER_HOME_ENV];
  const stateHome = await mkdtemp(path.join(os.tmpdir(), "agent-broker-server-state-"));

  process.env[BROKER_HOME_ENV] = stateHome;
  await writeFile(
    path.join(stateHome, "config.json"),
    JSON.stringify(
      {
        version: 1,
        agents: {
          gemini: {
            max_poll_attempts: 1
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  try {
    const job = await getOrCreateAgentJob(
      {
        agent: "gemini",
        task: "Review the code",
        project_root: path.resolve("tests/fixtures/demo-project"),
        files: [],
        constraints: [],
        mode: "review",
        apply: false
      },
      "job-max-polls",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          agent: "gemini",
          model: "gemini-3.1-pro-preview",
          summary: "done",
          response: "ok",
          patches: [],
          files: {},
          notes: [],
          warnings: [],
          applied: false,
          applied_files: []
        };
      }
    );

    job.pollAttempts += 1;
    await assert.rejects(
      async () => {
        if (!job.result && !job.error && job.maxPollAttempts !== undefined) {
          job.pollAttempts += 1;
          if (job.pollAttempts > job.maxPollAttempts) {
            throw new Error(
              `Agent job "${job.id}" exceeded the broker max_poll_attempts limit of ${job.maxPollAttempts}.`
            );
          }
        }
        await waitForAgentJob(job, 1);
      },
      /exceeded the broker max_poll_attempts limit/
    );
  } finally {
    if (originalBrokerHome === undefined) {
      delete process.env[BROKER_HOME_ENV];
    } else {
      process.env[BROKER_HOME_ENV] = originalBrokerHome;
    }
    await rm(stateHome, { recursive: true, force: true });
    resetAgentJobsForTests();
  }
});
