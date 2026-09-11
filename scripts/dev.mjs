#!/usr/bin/env node
/**
 * Starts the whole development stack in one terminal: the orchestrator, the stub AAS server, and
 * the Vite dev server pointed at the orchestrator.
 *
 * Running a benchmark needs all three (see CLAUDE.md, "Commands"), and wiring them up by hand
 * means three terminals plus remembering `KAIGARA_BACKEND_URL` — forget it and the Run button
 * posts into the Vite dev server and gets a 404. This script exists so that is not something
 * anyone has to know.
 *
 *   npm run dev               backend + stub AAS + frontend
 *   npm run dev -- --no-stub  the same, without the stub, for aiming at a real server
 *
 * No dependency: a process runner is `spawn` plus the discipline to clean up after itself, and
 * this project would rather not add a package for that. Ctrl-C stops everything; so does any one
 * service exiting, because two thirds of a stack running is worse than none — it looks like it
 * works right up until the Run button.
 */
import { spawn } from "node:child_process";
import process from "node:process";
import { portFree, whoHolds } from "./ports.mjs";

const BACKEND_URL = "http://127.0.0.1:5174";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const withStub = !process.argv.includes("--no-stub");

// Colour is dropped when stdout is not a terminal, so piping to a file or a CI log stays readable.
const ESC = String.fromCharCode(27);
const colour = process.stdout.isTTY
  ? (code, text) => ESC + "[" + code + "m" + text + ESC + "[0m"
  : (_code, text) => text;

const services = [
  { name: "backend", code: "36", port: 5174, args: ["run", "dev", "-w", "backend"] },
  ...(withStub ? [{ name: "stub-aas", code: "35", port: 8081, args: ["run", "stub-aas", "-w", "backend"] }] : []),
  {
    name: "frontend",
    code: "32",
    port: 5173,
    // The two Node servers read HOST; Vite does not, it needs `--host`. The Dev Container sets
    // HOST=0.0.0.0 (a loopback bind is right on a laptop and wrong in a container, where it makes
    // the server unreachable from a published port), so translate that into the flag Vite wants
    // rather than making anyone remember the asymmetry.
    args: ["run", "dev", "-w", "frontend", ...(process.env.HOST === "0.0.0.0" ? ["--", "--host"] : [])],
    // The one piece of wiring: without it the dev server serves its own in-process probe and
    // scenario library, and has nowhere to send `POST /api/runs`.
    env: { KAIGARA_BACKEND_URL: BACKEND_URL },
  },
];

const width = Math.max(...services.map((service) => service.name.length));
const children = [];
let shuttingDown = false;

// Refuse to start when a port is already taken, naming the service that wanted it and who holds
// it. See scripts/ports.mjs for why a silent second copy is the failure worth designing against.
const taken = [];
for (const service of services) {
  if (!(await portFree(service.port))) taken.push(service);
}
if (taken.length > 0) {
  for (const service of taken) {
    process.stdout.write(`${prefix(service)}port ${service.port} is already in use\n`);
    for (const holder of whoHolds(service.port)) {
      process.stdout.write(`${prefix(service)}  held by ${holder}\n`);
    }
  }
  process.stdout.write("\n  One is already running. Clear the ports with:  npm run stop\n\n");
  process.exit(1);
}

function prefix(service) {
  return colour(service.code, `${service.name.padEnd(width)} | `);
}

/** Line-buffers a stream so a prefix never lands mid-line, which is what makes three interleaved
 *  servers readable rather than a wall of text. */
function pipe(stream, service) {
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) process.stdout.write(`${prefix(service)}${line}\n`);
  });
  stream.on("end", () => {
    if (buffered) process.stdout.write(`${prefix(service)}${buffered}\n`);
  });
}

function stopAll(signal = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
}

for (const service of services) {
  const child = spawn(npm, service.args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...service.env },
  });
  children.push(child);
  pipe(child.stdout, service);
  pipe(child.stderr, service);

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    process.stdout.write(`${prefix(service)}exited (${signal ?? `code ${code}`}) - stopping the rest\n`);
    stopAll();
    process.exitCode = code ?? 1;
  });
  child.on("error", (error) => {
    process.stdout.write(`${prefix(service)}${error.message}\n`);
    stopAll();
    process.exitCode = 1;
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stopAll(signal));

process.stdout.write(
  "\n  Kaigara dev stack\n" +
    "    frontend   http://127.0.0.1:5173\n" +
    `    backend    ${BACKEND_URL}\n` +
    (withStub ? "    stub AAS   http://127.0.0.1:8081/api/v3\n" : "") +
    "  Ctrl-C stops all of them.\n\n",
);
