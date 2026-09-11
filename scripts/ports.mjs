#!/usr/bin/env node
/**
 * "Is this port free?", used two ways.
 *
 * As a module by `scripts/dev.mjs`, and as a `pre*` hook by the backend workspace so that starting
 * a server on its own refuses just as loudly as starting the whole stack does:
 *
 *   node scripts/ports.mjs 5174 backend
 *
 * It exists because the failure it replaces is silent. The backend runs under `node --watch`, which
 * keeps the supervisor alive after a failed `listen` and sits there waiting for a file to change —
 * so a second copy looks exactly like a running server, right down to the terminal not returning,
 * and the first sign of trouble is a request going to the *other* one.
 */
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";
import process from "node:process";

/** Resolves false when something already holds the port on loopback. */
export function portFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

/** Who holds it, as "pid command" lines. Best-effort: `lsof` is not on every machine, and not
 *  having it costs a nicer message, not the check itself. */
export function whoHolds(port) {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const holders = [];
    let pid = null;
    for (const line of out.split("\n")) {
      if (line.startsWith("p")) pid = line.slice(1);
      if (line.startsWith("c") && pid) holders.push(`pid ${pid} (${line.slice(1)})`);
    }
    return holders;
  } catch {
    return [];
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2]);
  const label = process.argv[3] ?? "server";
  if (!Number.isFinite(port)) {
    console.error("usage: node scripts/ports.mjs <port> [label]");
    process.exit(2);
  }
  if (!(await portFree(port))) {
    const holders = whoHolds(port);
    console.error(`\n  ${label}: port ${port} is already in use — one is already running.`);
    for (const holder of holders) console.error(`    held by ${holder}`);
    console.error(`  Stop it with:  npm run stop\n`);
    process.exit(1);
  }
}
