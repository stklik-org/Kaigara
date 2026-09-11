#!/usr/bin/env node
/**
 * Stops whatever is listening on Kaigara's development ports.
 *
 * The companion to the checks in `ports.mjs`: those tell you a port is taken, this clears it. Aimed
 * at the specific mess this project makes — a `node --watch` supervisor left over in a terminal
 * that has long since scrolled away, still holding :5174 and quietly answering requests meant for
 * the copy you just started.
 *
 *   npm run stop
 */
import { execFileSync } from "node:child_process";
import process from "node:process";
import { portFree, whoHolds } from "./ports.mjs";

/**
 * The process group holding a port, not just the process.
 *
 * Killing the listener alone does not stop a dev server: `node --watch` supervises it and starts a
 * fresh one the next time a file changes, so the port comes back and it looks like the stop did
 * nothing. The supervisor, its npm parent and the server all share a process group — an
 * interactive shell puts each job in its own — so the group is the thing to signal.
 */
function groupOf(pid) {
  try {
    const out = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
    const pgid = Number(out.trim());
    return Number.isFinite(pgid) && pgid > 1 ? pgid : null;
  } catch {
    return null;
  }
}

const PORTS = [
  { port: 5173, label: "frontend (Vite)" },
  { port: 5174, label: "backend (orchestrator)" },
  { port: 8081, label: "stub AAS server" },
];

let stopped = 0;
for (const { port, label } of PORTS) {
  if (await portFree(port)) {
    console.log(`  ${String(port).padEnd(5)} free            ${label}`);
    continue;
  }
  const holders = whoHolds(port);
  for (const holder of holders) {
    const pid = Number(holder.match(/pid (\d+)/)?.[1]);
    if (!Number.isFinite(pid)) continue;
    const pgid = groupOf(pid);
    try {
      // SIGTERM, not SIGKILL: a dev server should get the chance to close its sockets, and
      // anything that ignores it is something to look at rather than silently destroy. The group
      // rather than the pid, so the `node --watch` supervisor goes too and nothing respawns.
      if (pgid) process.kill(-pgid, "SIGTERM");
      else execFileSync("kill", [String(pid)]);
      console.log(`  ${String(port).padEnd(5)} stopped ${holder}${pgid ? ` and its group (pgid ${pgid})` : ""}  ${label}`);
      stopped += 1;
    } catch {
      console.log(`  ${String(port).padEnd(5)} could not stop ${holder} — try it by hand`);
    }
  }
}

if (stopped === 0) console.log("\n  Nothing to stop.\n");
else console.log(`\n  Stopped ${stopped}. Anything under \`npm run dev\` in another terminal will have exited with it.\n`);
