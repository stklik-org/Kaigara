import { useState } from "react";
import type { ServerConnection } from "@kaigara/shared-types";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { useApi } from "@/lib/api/ApiContext";
import { useAsyncData } from "@/lib/useAsyncData";
import { ConnectionForm } from "./ConnectionForm";
import { ConnectionTestResultView } from "./ConnectionTestResultView";

function conformanceTone(status: ServerConnection["conformanceStatus"]): BadgeTone {
  if (status === "full") return "pass";
  if (status === "partial") return "warn";
  return "neutral";
}

function reachabilityBadge(reachable: ServerConnection["reachable"]): { tone: BadgeTone; label: string } {
  if (reachable === true) return { tone: "pass", label: "Reachable" };
  if (reachable === false) return { tone: "fail", label: "Unreachable" };
  return { tone: "neutral", label: "Untested" };
}

/** Mirrors the wireframe's Connect screen (2a/2aL). Unlike the rest of the prototype this screen
 *  is not mocked: "Test" really probes the target server's IDTA-01002 Service Description through
 *  the backend (see `lib/api/connectionsClient.ts`), and the connection list is the user's own. */
export function ConnectPage() {
  const api = useApi();
  const { data: connections, reload } = useAsyncData(() => api.connections.list(), [api]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  /** Runs a mutation with the row marked busy, then re-reads the list — the client owns the state,
   *  so the screen never patches its own copy and can't drift from it. */
  async function withPending(id: string, action: () => Promise<unknown>) {
    setPendingId(id);
    try {
      await action();
      await reload();
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-ink">Server connections</h1>
        <span className="text-xs text-ink-muted">Test probes GET {"{base URL}"}/description</span>
      </div>

      {!connections ? (
        <div className="text-sm text-ink-muted">Loading…</div>
      ) : (
        <div className="space-y-3">
          {connections.map((connection) => {
            const busy = pendingId === connection.id;

            if (editingId === connection.id) {
              return (
                <Panel key={connection.id} className="p-4">
                  <ConnectionForm
                    connection={connection}
                    submitLabel="Save"
                    onCancel={() => setEditingId(null)}
                    onSubmit={async (input) => {
                      setEditingId(null);
                      await withPending(connection.id, () => api.connections.update(connection.id, input));
                    }}
                  />
                </Panel>
              );
            }

            const reachability = reachabilityBadge(connection.reachable);

            return (
              <Panel key={connection.id} className={`p-4 ${connection.active ? "border-accent" : ""}`}>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-ink">{connection.name}</span>
                      {connection.active && <Badge tone="pass">Active</Badge>}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-muted">{connection.environment}</div>
                    <div className="mt-2 font-mono text-xs text-ink-muted">{connection.baseUrl}</div>
                  </div>
                  <div className="flex flex-none flex-col items-end gap-1.5">
                    <Badge tone={conformanceTone(connection.conformanceStatus)}>{connection.conformanceProfile}</Badge>
                    <Badge tone={reachability.tone}>{reachability.label}</Badge>
                  </div>
                </div>

                <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
                  <div className="flex gap-3 text-xs text-ink-muted">
                    <span>API {connection.apiVersion}</span>
                    <span>timeout {connection.defaultTimeoutSeconds}s</span>
                    <span>{connection.scrapeResourceMetrics ? "metrics on" : "metrics off"}</span>
                  </div>
                  <div className="flex gap-2">
                    <Button disabled={busy} onClick={() => setEditingId(connection.id)}>
                      Edit
                    </Button>
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={() => withPending(connection.id, () => api.connections.remove(connection.id))}
                    >
                      Remove
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() => withPending(connection.id, () => api.connections.test(connection.id))}
                    >
                      {busy ? "Testing…" : "Test"}
                    </Button>
                    <Button
                      variant="primary"
                      disabled={connection.active || busy}
                      onClick={() => withPending(connection.id, () => api.connections.activate(connection.id))}
                    >
                      {connection.active ? "Active" : "Activate"}
                    </Button>
                  </div>
                </div>

                {connection.lastTest && <ConnectionTestResultView result={connection.lastTest} />}
              </Panel>
            );
          })}

          {adding ? (
            <Panel className="p-4">
              <ConnectionForm
                submitLabel="Add connection"
                onCancel={() => setAdding(false)}
                onSubmit={async (input) => {
                  setAdding(false);
                  const created = await api.connections.create(input);
                  await reload();
                  // Probe straight away: a connection nobody has tested is one nobody can trust.
                  await withPending(created.id, () => api.connections.test(created.id));
                }}
              />
            </Panel>
          ) : (
            <Panel dashed className="p-4">
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="w-full text-sm font-medium text-ink-muted hover:text-ink"
              >
                + Add connection
              </button>
            </Panel>
          )}
        </div>
      )}
    </div>
  );
}
