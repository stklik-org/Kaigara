import { useCallback, useEffect, useState } from "react";
import type { ConnectionInput, ConnectionTestResult, ServerConnection } from "@kaigara/shared-types";
import { useApi } from "../../lib/api/ApiContext";
import { Panel } from "../../components/ui/Panel";
import { Badge, type BadgeTone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";

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

/** A probe that reached the server but found no ServiceDescription is a warning, not a pass:
 *  the server answers, but Kaigara cannot tell which conformance profiles it implements. */
function resultTone(result: ConnectionTestResult): BadgeTone {
  if (!result.reachable) return result.error?.kind === "probe-unavailable" ? "warn" : "fail";
  return result.profiles ? "pass" : "warn";
}

/** "…/AssetAdministrationShellRepositoryServiceSpecification/SSP-002" -> "AAS Repository SSP-002" */
function shortProfileLabel(profile: string): string {
  const segments = profile.split("/").filter(Boolean);
  const ssp = segments.at(-1) ?? profile;
  const spec = (segments.at(-2) ?? "")
    .replace(/ServiceSpecification$/, "")
    .replace(/^AssetAdministrationShell/, "AAS ")
    .replace(/([a-z])([A-Z])/g, "$1 $2");
  return spec ? `${spec.trim()} ${ssp}` : ssp;
}

function TestResult({ result }: { result: ConnectionTestResult }) {
  const tone = resultTone(result);
  const label = result.reachable ? "Reachable" : result.error?.kind === "probe-unavailable" ? "Probe failed" : "Unreachable";

  return (
    <div className="mt-3 space-y-2 border-t border-border pt-3">
      <div className="flex items-start gap-2">
        <span className="flex-none whitespace-nowrap">
          <Badge tone={tone}>{label}</Badge>
        </span>
        <p className="text-xs leading-relaxed text-ink-muted">{result.detail}</p>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-ink-muted">
        <span>GET {result.probedUrl}</span>
        {result.httpStatus !== undefined && <span>→ {result.httpStatus}</span>}
        {result.latencyMs !== undefined && <span>{result.latencyMs} ms</span>}
        <span>at {new Date(result.checkedAt).toLocaleTimeString()}</span>
      </div>
      {result.profiles && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-ink-muted">Server advertises:</span>
          {result.profiles.map((profile) => (
            <span
              key={profile}
              title={profile}
              className="inline-flex items-center rounded border border-border-strong bg-surface-sunken px-1.5 py-0.5 text-[11px] text-ink-muted"
            >
              {shortProfileLabel(profile)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const EMPTY_FORM = { name: "", baseUrl: "", environment: "", defaultTimeoutSeconds: "30" };
type FormState = typeof EMPTY_FORM;

function toFormState(connection: ServerConnection): FormState {
  return {
    name: connection.name,
    baseUrl: connection.baseUrl,
    environment: connection.environment,
    defaultTimeoutSeconds: String(connection.defaultTimeoutSeconds),
  };
}

const FIELD_CLASS =
  "w-full rounded border border-field-border bg-field px-2 py-1 text-sm text-ink outline-none focus:border-accent";

function ConnectionForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: FormState;
  submitLabel: string;
  onSubmit: (input: ConnectionInput) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<FormState>(initial);
  const [error, setError] = useState<string | null>(null);

  function field(key: keyof FormState) {
    return {
      value: form[key],
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        setForm((prev) => ({ ...prev, [key]: event.target.value })),
    };
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!form.name.trim()) return setError("Give the connection a name.");
    if (!/^https?:\/\//i.test(form.baseUrl.trim())) {
      return setError("The base URL needs an http(s):// scheme, e.g. http://localhost:8081/api/v3.");
    }
    setError(null);
    onSubmit({
      name: form.name,
      baseUrl: form.baseUrl,
      environment: form.environment,
      defaultTimeoutSeconds: Number(form.defaultTimeoutSeconds) || 30,
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className="text-xs font-medium text-ink-muted">Name</span>
          <input className={FIELD_CLASS} placeholder="Eclipse BaSyx" {...field("name")} />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-ink-muted">Environment</span>
          <input className={FIELD_CLASS} placeholder="local docker · v3 API" {...field("environment")} />
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-ink-muted">
          Base URL <span className="font-normal">— the IDTA-01002 API root, without /description</span>
        </span>
        <input className={`${FIELD_CLASS} font-mono`} placeholder="http://localhost:8081/api/v3" {...field("baseUrl")} />
      </label>
      <label className="block w-40 space-y-1">
        <span className="text-xs font-medium text-ink-muted">Timeout (s)</span>
        <input className={FIELD_CLASS} type="number" min={1} max={120} {...field("defaultTimeoutSeconds")} />
      </label>
      {error && <p className="text-xs text-status-fail">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary">
          {submitLabel}
        </Button>
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Mirrors the wireframe's Connect screen (2a/2aL). Unlike the rest of the prototype this screen
 *  is not mocked: "Test" really probes the target server's IDTA-01002 Service Description through
 *  the backend (see `lib/api/connectionsClient.ts`), and the connection list is the user's own. */
export function ConnectPage() {
  const api = useApi();
  const [connections, setConnections] = useState<ServerConnection[] | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => setConnections(await api.connections.list()), [api]);

  useEffect(() => {
    let cancelled = false;
    api.connections.list().then((list) => {
      if (!cancelled) setConnections(list);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function withPending(id: string, action: () => Promise<unknown>) {
    setPendingId(id);
    try {
      await action();
      await refresh();
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
            const reachability = reachabilityBadge(connection.reachable);
            const busy = pendingId === connection.id;

            if (editingId === connection.id) {
              return (
                <Panel key={connection.id} className="p-4">
                  <ConnectionForm
                    initial={toFormState(connection)}
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
                    <Button disabled={busy} onClick={() => withPending(connection.id, () => api.connections.test(connection.id))}>
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

                {connection.lastTest && <TestResult result={connection.lastTest} />}
              </Panel>
            );
          })}

          {adding ? (
            <Panel className="p-4">
              <ConnectionForm
                initial={EMPTY_FORM}
                submitLabel="Add connection"
                onCancel={() => setAdding(false)}
                onSubmit={async (input) => {
                  setAdding(false);
                  const created = await api.connections.create(input);
                  await refresh();
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
