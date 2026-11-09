process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import { createTseSweep } from "../../src/jobs/tseSweep.js";
import { shutdownResources, startJobs } from "../../src/server.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("an overlapping sweep run is skipped", async () => {
  const gate = deferred();
  const signed = [];
  const sweep = createTseSweep({
    findDue: async () => [{ _id: "a" }, { _id: "b" }],
    sign: async (id) => {
      await gate.promise;
      signed.push(id);
    },
  });
  const first = sweep.runOnce();
  const second = await sweep.runOnce();
  assert.deepEqual(second, { skipped: true });
  gate.resolve();
  assert.deepEqual(await first, { skipped: false, attempted: 2 });
  assert.deepEqual(signed, ["a", "b"]);
  // Free again once the run finished.
  assert.equal((await sweep.runOnce()).skipped, false);
});

test("the sweep asks for at most 50 due payments below 20 retries", async () => {
  let asked;
  const now = new Date("2026-11-09T12:00:00Z");
  const sweep = createTseSweep({
    now: () => now,
    findDue: async (query) => {
      asked = query;
      return [];
    },
    sign: async () => {},
  });
  await sweep.runOnce();
  assert.deepEqual(asked, { now, limit: 50, maxRetries: 20 });
});

test("one payment's error does not stop the rest of the batch", async () => {
  const signed = [];
  const sweep = createTseSweep({
    findDue: async () => [{ _id: "a" }, { _id: "b" }],
    sign: async (id) => {
      if (id === "a") throw new Error("boom");
      signed.push(id);
    },
  });
  await sweep.runOnce();
  assert.deepEqual(signed, ["b"]);
});

test("the sweep runs every interval and stop waits for the current run", async () => {
  let runs = 0;
  const gate = deferred();
  const sweep = createTseSweep({
    intervalMs: 10,
    findDue: async () => {
      runs += 1;
      return [{ _id: "a" }];
    },
    sign: () => gate.promise,
  });
  sweep.start();
  while (runs === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  let stopped = false;
  const stopping = sweep.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(stopped, false, "stop waits for the run in progress");
  gate.resolve();
  await stopping;
  const after = runs;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(runs, after, "no runs after stop");
  assert.equal(after, 1, "the run in progress blocked further ticks");
});

test("jobs start only with ENABLE_JOBS=true", () => {
  let created = 0;
  let started = 0;
  const createSweep = () => {
    created += 1;
    return {
      start: () => {
        started += 1;
      },
      stop: async () => {},
    };
  };
  assert.equal(startJobs({ ENABLE_JOBS: "false" }, { createSweep }), null);
  assert.equal(startJobs({}, { createSweep }), null);
  assert.equal(created, 0);
  const jobs = startJobs({ ENABLE_JOBS: "true" }, { createSweep });
  assert.ok(jobs);
  assert.equal(created, 1);
  assert.equal(started, 1);
});

test("shutdown stops the jobs before the database disconnects", async () => {
  const order = [];
  await shutdownResources({
    jobs: { stop: async () => order.push("jobs") },
    disconnect: async () => order.push("db"),
    signal: "test",
  });
  assert.deepEqual(order, ["jobs", "db"]);
});
