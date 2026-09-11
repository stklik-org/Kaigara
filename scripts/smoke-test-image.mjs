#!/usr/bin/env node
/**
 * Does a Kaigara image actually work? Starts it, with the stub AAS server from the same image beside
 * it, and checks what a published image has to get right that no unit test can see:
 *
 *   node scripts/smoke-test-image.mjs [image]          (default: kaigara:local)
 *
 * - k6 runs on this platform and the orchestrator finds it;
 * - the orchestrator serves the API and the UI on one port, and finds its bundled scenario library;
 * - the connection probe reaches a server from inside the container;
 * - a real benchmark — the shipped `minimal-crud` scenario, against the stub — runs to completion;
 * - the run archive was written, i.e. the unprivileged user can write where it needs to;
 * - `docker stop` is honoured promptly, i.e. an init is forwarding SIGTERM to Node.
 *
 * `.github/workflows/docker-image.yml` runs it before anything is pushed. Everything it starts is
 * named after this process and removed again, and the orchestrator gets a random host port, so it
 * can run beside a development stack that holds 5174 and 8081.
 */
import { execFileSync } from "node:child_process";
import process from "node:process";

const image = process.argv[2] ?? "kaigara:local";
const name = `kaigara-smoke-${process.pid}`;
const stubName = `${name}-stub`;
/** Short enough to keep CI quick, and a load light enough that the runner's CPU is not the story. */
const SCENARIO_ID = "minimal-crud";

function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function pass(message) {
  console.log(`  ✓ ${message}`);
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
  pass(message);
}

async function json(url, body) {
  const response = await fetch(url, body === undefined ? undefined : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${url} answered ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

/** Polls `probe` until it returns something truthy, which it then returns. A probe that throws —
 *  a connection refused while the server is still starting — counts as "not yet". */
async function until(what, probe, { timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}${lastError ? ` (${lastError.message})` : ""}`);
}

async function smokeTest() {
  console.log(`Smoke-testing ${image}`);

  const k6Version = docker("run", "--rm", image, "k6", "version").split("\n")[0];
  pass(`k6 runs in the image: ${k6Version}`);

  docker("network", "create", name);
  docker("run", "-d", "--name", stubName, "--network", name, "-e", "PORT=8081", image, "node", "backend/src/devtools/stubAasServer.ts");
  docker("run", "-d", "--name", name, "--network", name, "-p", "127.0.0.1::5174", image);
  const base = `http://${docker("port", name, "5174/tcp").split("\n")[0]}`;

  await until("the orchestrator to answer /api/health", async () => (await fetch(`${base}/api/health`)).ok);
  pass(`the orchestrator answers on ${base}`);

  // A deep link rather than `/`: the UI is client-routed, so this also covers the index.html fallback.
  const page = await (await fetch(`${base}/compose`)).text();
  expect(page.includes('<div id="root">'), "the UI is served from the same port, deep links included");

  const { engines } = await json(`${base}/api/engines`);
  const k6 = engines.find((engine) => engine.id === "k6");
  expect(k6?.available === true, `the orchestrator can run k6 (${k6?.detail ?? "not registered"})`);

  const library = await json(`${base}/api/scenarios`);
  const usable = library.entries.filter((entry) => !entry.issues?.length);
  expect(usable.some((entry) => entry.id === SCENARIO_ID), `the bundled library opens (${usable.length} of ${library.entries.length} scenarios usable)`);

  const target = { baseUrl: `http://${stubName}:8081/api/v3` };
  await until("the stub to be reachable from the orchestrator", async () => (await json(`${base}/api/connections/test`, target)).reachable === "yes");
  pass(`the connection probe reaches ${target.baseUrl}`);

  const created = await json(`${base}/api/runs/scenario`, { scenarioId: SCENARIO_ID, target });
  pass(`run ${created.id} started (${SCENARIO_ID}, ${created.status})`);
  const run = await until(
    `run ${created.id} to finish`,
    async () => {
      const current = await json(`${base}/api/runs/${created.id}`);
      return ["completed", "failed", "stopped"].includes(current.status) ? current : undefined;
    },
    { timeoutMs: 180_000, intervalMs: 2_000 },
  );
  expect(run.status === "completed", run.status === "completed" ? "the run completed" : `the run ${run.status}: ${run.error ?? "no error given"}`);
  const { requests, failed } = run.metrics;
  expect(requests > failed, `requests reached the target (${requests} sent, ${failed} failed)`);

  const archived = docker("exec", name, "find", "/app/k6-logs", "-name", "ExecutionPlan.txt");
  expect(archived !== "", `the run archive was written (${archived.split("\n")[0]})`);

  const stopStarted = Date.now();
  docker("stop", "--time", "10", name);
  const stopMs = Date.now() - stopStarted;
  expect(stopMs < 5_000, `docker stop is honoured promptly (${stopMs} ms, not the 10 s kill timeout)`);
}

function cleanUp() {
  for (const args of [["rm", "-f", name, stubName], ["network", "rm", name]]) {
    try {
      docker(...args);
    } catch {
      // Already gone, or never created because an earlier step failed — either way, nothing to do.
    }
  }
}

try {
  await smokeTest();
  console.log("\nThe image works.");
} catch (error) {
  console.error(`\n  ✗ ${error.message}`);
  for (const container of [name, stubName]) {
    try {
      console.error(`\n--- docker logs ${container} (last 40 lines) ---`);
      // Inherited rather than captured: a container's stderr is most of what explains a failure.
      execFileSync("docker", ["logs", "--tail", "40", container], { stdio: ["ignore", "inherit", "inherit"] });
    } catch {
      console.error("(no logs — the container never started)");
    }
  }
  process.exitCode = 1;
} finally {
  cleanUp();
}
