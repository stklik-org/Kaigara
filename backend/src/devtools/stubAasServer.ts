/**
 * A deliberately minimal, in-memory stand-in for an AAS server — **development only**.
 *
 * This is not an AAS implementation and must never be mistaken for one: it implements just enough
 * of the IDTA-01002 repository surface for Kaigara's own pipeline to be exercised end to end
 * (compile a timeline → generate a k6 script → issue real HTTP requests → parse real metrics)
 * without needing twinsphere or a BaSyx container running. It validates almost nothing.
 *
 * For real comparison runs, point Kaigara at a real server; the proposal (section 11.3) suggests
 * spinning up a versioned BaSyx container via Testcontainers for exactly that.
 *
 *   npm run stub-aas -w backend            # listens on :8081, API root http://127.0.0.1:8081/api/v3
 *   PORT=9000 npm run stub-aas -w backend
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const PORT = Number(process.env.PORT ?? 8081);
const HOST = process.env.HOST ?? "127.0.0.1";
const BASE_PATH = process.env.BASE_PATH ?? "/api/v3";
/** Seed volume, so update/delete have something to address on a cold start. */
const SEED_COUNT = Number(process.env.SEED_COUNT ?? 50);
/** Optional artificial latency, to make a benchmark against the stub produce a realistic curve. */
const LATENCY_MS = Number(process.env.LATENCY_MS ?? 0);

type Entity = { id: string; [key: string]: unknown };

const store: Record<"shells" | "submodels", Map<string, Entity>> = {
  shells: new Map(),
  submodels: new Map(),
};

for (let i = 0; i < SEED_COUNT; i++) {
  const shellId = `https://kaigara.dev/seed/shell/${i}`;
  store.shells.set(shellId, { id: shellId, modelType: "AssetAdministrationShell", idShort: `seed_shell_${i}` });
  const submodelId = `https://kaigara.dev/seed/submodel/${i}`;
  store.submodels.set(submodelId, { id: submodelId, modelType: "Submodel", idShort: `seed_submodel_${i}` });
}

function decodeId(segment: string): string | null {
  try {
    // IDTA-01002 uses unpadded base64url in path segments.
    return Buffer.from(segment, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    response.writeHead(status);
    response.end();
    return;
  }
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const path = url.pathname.startsWith(BASE_PATH) ? url.pathname.slice(BASE_PATH.length) : url.pathname;
  const segments = path.split("/").filter(Boolean);

  if (segments.length === 1 && segments[0] === "description") {
    send(response, 200, {
      profiles: [
        "https://admin-shell.io/aas/API/3/0/AssetAdministrationShellRepositoryServiceSpecification/SSP-002",
        "https://admin-shell.io/aas/API/3/0/SubmodelRepositoryServiceSpecification/SSP-002",
      ],
    });
    return;
  }

  const collection = segments[0];
  if (collection !== "shells" && collection !== "submodels") {
    send(response, 404, { error: `Unknown path ${url.pathname}` });
    return;
  }
  const entities = store[collection];

  // Collection endpoints: paged read and create.
  if (segments.length === 1) {
    if (request.method === "GET") {
      const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit") ?? 20)));
      const result = [...entities.values()].slice(0, limit);
      send(response, 200, { result, paging_metadata: {} });
      return;
    }
    if (request.method === "POST") {
      const raw = await readBody(request);
      let parsed: Entity;
      try {
        parsed = JSON.parse(raw);
      } catch {
        send(response, 400, { error: "Body is not valid JSON." });
        return;
      }
      if (typeof parsed?.id !== "string") {
        send(response, 400, { error: 'Body must carry a string "id".' });
        return;
      }
      entities.set(parsed.id, parsed);
      send(response, 201, parsed);
      return;
    }
    send(response, 405, { error: `${request.method} not allowed on /${collection}` });
    return;
  }

  // Per-entity endpoints.
  if (segments.length === 2) {
    const id = decodeId(segments[1]);
    if (id === null) {
      send(response, 400, { error: "Path identifier is not valid base64url." });
      return;
    }

    if (request.method === "GET") {
      const found = entities.get(id);
      if (!found) {
        send(response, 404, { error: `No ${collection} with id ${id}` });
        return;
      }
      send(response, 200, found);
      return;
    }

    if (request.method === "PUT") {
      const raw = await readBody(request);
      if (!entities.has(id)) {
        send(response, 404, { error: `No ${collection} with id ${id}` });
        return;
      }
      try {
        entities.set(id, { ...(JSON.parse(raw) as Entity), id });
      } catch {
        send(response, 400, { error: "Body is not valid JSON." });
        return;
      }
      send(response, 204);
      return;
    }

    if (request.method === "DELETE") {
      if (!entities.delete(id)) {
        send(response, 404, { error: `No ${collection} with id ${id}` });
        return;
      }
      send(response, 204);
      return;
    }
  }

  send(response, 404, { error: `Unknown path ${url.pathname}` });
}

const server = createServer((request, response) => {
  const run = (): void => {
    handle(request, response).catch((error) => {
      send(response, 500, { error: (error as Error).message });
    });
  };
  if (LATENCY_MS > 0) setTimeout(run, LATENCY_MS);
  else run();
});

// A benchmark target must not be the bottleneck by accident: Node's default of unlimited sockets
// is what we want, but the default 5s keep-alive timeout would churn connections under load.
server.keepAliveTimeout = 60_000;
server.headersTimeout = 65_000;

server.listen(PORT, HOST, () => {
  console.log(`Stub AAS server (development only) on http://${HOST}:${PORT}${BASE_PATH}`);
  console.log(`Seeded ${SEED_COUNT} shells and ${SEED_COUNT} submodels.`);
});
