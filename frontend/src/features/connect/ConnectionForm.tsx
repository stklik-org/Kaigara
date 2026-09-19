import { useId, useState, type ChangeEvent, type FormEvent } from "react";
import type { ConnectionInput, ServerConnection } from "@kaigara/shared-types";
import { Button } from "@/components/ui/Button";

const FIELD_CLASS =
  "w-full rounded border border-field-border bg-field px-2 py-1 text-sm text-ink outline-none focus:border-accent";

const DEFAULT_TIMEOUT_SECONDS = 30;

/** A header row that has a name is "real"; a trailing blank row is always kept so there is
 *  somewhere to start typing the next one without an explicit "+ Add" click first. */
type HeaderRow = { id: string; name: string; value: string };

function headerRowsFrom(headers: Record<string, string> | undefined): HeaderRow[] {
  const rows = Object.entries(headers ?? {}).map(([name, value], index) => ({
    id: `existing-${index}`,
    name,
    value,
  }));
  return [...rows, { id: "new", name: "", value: "" }];
}

function headersFromRows(rows: HeaderRow[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name) headers[name] = row.value;
  }
  return headers;
}

/** A header value looks worth masking at rest if its name suggests a credential — the point is to
 *  stop a secret from sitting in plain sight on screen, not to guess perfectly. */
function looksSecret(name: string): boolean {
  return /auth|secret|token|key|password|credential/i.test(name);
}

/** OAuth2 client-credentials fields, kept as one blank-or-complete unit rather than four
 *  independent optionals — a half-filled set isn't a usable auth config, so `submit()` only turns
 *  this into `ConnectionInput.oauth2` when every field has something in it. */
type OAuth2FormState = { tokenUrl: string; clientId: string; clientSecret: string; scope: string };

const BLANK_OAUTH2: OAuth2FormState = { tokenUrl: "", clientId: "", clientSecret: "", scope: "" };

function oauth2FormStateFrom(oauth2: ServerConnection["oauth2"]): OAuth2FormState {
  return oauth2 ? { ...oauth2 } : { ...BLANK_OAUTH2 };
}

function isOAuth2FormBlank(oauth2: OAuth2FormState): boolean {
  return !oauth2.tokenUrl.trim() && !oauth2.clientId.trim() && !oauth2.clientSecret.trim() && !oauth2.scope.trim();
}

/** The form's own state is all strings — a half-typed timeout is not a number yet, and forcing it
 *  to be one mid-keystroke is how a field ends up fighting the person filling it in. */
type FormState = {
  name: string;
  baseUrl: string;
  environment: string;
  defaultTimeoutSeconds: string;
  headerRows: HeaderRow[];
  oauth2Enabled: boolean;
  oauth2: OAuth2FormState;
};

function toFormState(connection: ServerConnection | undefined): FormState {
  return {
    name: connection?.name ?? "",
    baseUrl: connection?.baseUrl ?? "",
    environment: connection?.environment ?? "",
    defaultTimeoutSeconds: String(connection?.defaultTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS),
    headerRows: headerRowsFrom(connection?.headers),
    oauth2Enabled: Boolean(connection?.oauth2),
    oauth2: oauth2FormStateFrom(connection?.oauth2),
  };
}

/** Add/edit form for a server connection. Validation is deliberately thin — a name and a URL with
 *  a scheme — because whether the target is actually an AAS server is what the Test button is for,
 *  and guessing here would only reject URLs that turn out to work. */
export function ConnectionForm({
  connection,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  /** The connection being edited, or undefined to add a new one. */
  connection?: ServerConnection;
  submitLabel: string;
  onSubmit: (input: ConnectionInput) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => toFormState(connection));
  const [error, setError] = useState<string | null>(null);
  // Which header rows are shown in the clear. Off by default for anything credential-shaped, so a
  // secret pasted in here does not just sit legible on screen — see `looksSecret`.
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());
  const formId = useId();

  function field(key: "name" | "baseUrl" | "environment" | "defaultTimeoutSeconds") {
    return {
      value: form[key],
      onChange: (event: ChangeEvent<HTMLInputElement>) =>
        setForm((prev) => ({ ...prev, [key]: event.target.value })),
    };
  }

  /** Keeps exactly one blank row at the end, so there is always somewhere to start typing the next
   *  header without an explicit "+ Add" click. */
  function ensureTrailingBlank(rows: HeaderRow[]): HeaderRow[] {
    const last = rows[rows.length - 1];
    if (!last || last.name.trim() !== "") {
      return [...rows, { id: `${formId}-${rows.length}-${Date.now()}`, name: "", value: "" }];
    }
    return rows;
  }

  function updateHeaderRow(id: string, patch: Partial<Pick<HeaderRow, "name" | "value">>) {
    setForm((prev) => ({
      ...prev,
      headerRows: ensureTrailingBlank(prev.headerRows.map((row) => (row.id === id ? { ...row, ...patch } : row))),
    }));
  }

  function removeHeaderRow(id: string) {
    setForm((prev) => ({ ...prev, headerRows: ensureTrailingBlank(prev.headerRows.filter((row) => row.id !== id)) }));
  }

  function toggleRevealed(id: string) {
    setRevealedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function updateOAuth2(patch: Partial<OAuth2FormState>) {
    setForm((prev) => ({ ...prev, oauth2: { ...prev.oauth2, ...patch } }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.name.trim()) {
      setError("Give the connection a name.");
      return;
    }
    if (!/^https?:\/\//i.test(form.baseUrl.trim())) {
      setError("The base URL needs an http(s):// scheme, e.g. http://localhost:8081/api/v3.");
      return;
    }
    if (form.oauth2Enabled && isOAuth2FormBlank(form.oauth2)) {
      setError("Fill in all four OAuth2 fields, or turn OAuth2 off.");
      return;
    }
    if (form.oauth2Enabled && !isOAuth2FormBlank(form.oauth2)) {
      const missing = (["tokenUrl", "clientId", "clientSecret", "scope"] as const).filter((key) => !form.oauth2[key].trim());
      if (missing.length > 0) {
        setError(`OAuth2 needs all four fields — missing ${missing.join(", ")}.`);
        return;
      }
    }
    setError(null);
    onSubmit({
      name: form.name,
      baseUrl: form.baseUrl,
      environment: form.environment,
      defaultTimeoutSeconds: Number(form.defaultTimeoutSeconds) || DEFAULT_TIMEOUT_SECONDS,
      headers: headersFromRows(form.headerRows),
      oauth2: form.oauth2Enabled ? { ...form.oauth2 } : null,
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
      <div className="space-y-1">
        <span className="text-xs font-medium text-ink-muted">
          Headers <span className="font-normal">— sent verbatim on every request to this server, e.g. Authorization</span>
        </span>
        <div className="space-y-1.5">
          {form.headerRows.map((row) => {
            const isBlank = row.name.trim() === "" && row.value === "";
            const masked = looksSecret(row.name) && !revealedIds.has(row.id);
            return (
              <div key={row.id} className="flex items-center gap-1.5">
                {/* Sizing lives on these wrappers, not the inputs: FIELD_CLASS already bakes in
                    `w-full`, which — as a same-specificity utility class — otherwise wins the
                    cascade over a `w-36`/`flex-1` appended after it in the same class string,
                    collapsing the value field to nothing. */}
                <div className="w-36 flex-none">
                  <input
                    className={`${FIELD_CLASS} font-mono`}
                    placeholder="Header name"
                    value={row.name}
                    onChange={(event) => updateHeaderRow(row.id, { name: event.target.value })}
                  />
                </div>
                <div className="flex-1">
                  <input
                    className={`${FIELD_CLASS} font-mono`}
                    type={masked ? "password" : "text"}
                    placeholder="Value"
                    value={row.value}
                    onChange={(event) => updateHeaderRow(row.id, { value: event.target.value })}
                  />
                </div>
                {looksSecret(row.name) && (
                  <button
                    type="button"
                    onClick={() => toggleRevealed(row.id)}
                    title={masked ? "Show value" : "Hide value"}
                    className="flex-none px-1 text-xs text-ink-muted hover:text-ink"
                  >
                    {masked ? "Show" : "Hide"}
                  </button>
                )}
                {!isBlank && (
                  <button
                    type="button"
                    onClick={() => removeHeaderRow(row.id)}
                    title="Remove this header"
                    aria-label="Remove this header"
                    className="flex-none px-1 text-sm text-ink-muted hover:text-status-fail"
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <p className="text-[11px] text-ink-muted">
          Stored in this browser's local storage, like the rest of the connection — not a secrets vault.
        </p>
      </div>
      <div className="space-y-1.5 rounded border border-field-border p-2.5">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={form.oauth2Enabled}
            onChange={(event) => setForm((prev) => ({ ...prev, oauth2Enabled: event.target.checked }))}
          />
          <span className="text-xs font-medium text-ink-muted">
            OAuth2 client credentials{" "}
            <span className="font-normal">
              — the backend exchanges these for a bearer token before every Test/Run and sends it as{" "}
              <code className="font-mono">Authorization</code>, overriding a header of that name above.
            </span>
          </span>
        </label>
        {form.oauth2Enabled && (
          <div className="grid grid-cols-2 gap-2 pt-1">
            <label className="col-span-2 space-y-1">
              <span className="text-xs font-medium text-ink-muted">Token URL</span>
              <input
                className={`${FIELD_CLASS} font-mono`}
                placeholder="https://<tenant>.ciamlogin.com/<tenant-id>/oauth2/v2.0/token"
                value={form.oauth2.tokenUrl}
                onChange={(event) => updateOAuth2({ tokenUrl: event.target.value })}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-ink-muted">Client ID</span>
              <input
                className={`${FIELD_CLASS} font-mono`}
                value={form.oauth2.clientId}
                onChange={(event) => updateOAuth2({ clientId: event.target.value })}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-ink-muted">Client secret</span>
              <input
                className={`${FIELD_CLASS} font-mono`}
                type="password"
                value={form.oauth2.clientSecret}
                onChange={(event) => updateOAuth2({ clientSecret: event.target.value })}
              />
            </label>
            <label className="col-span-2 space-y-1">
              <span className="text-xs font-medium text-ink-muted">Scope</span>
              <input
                className={`${FIELD_CLASS} font-mono`}
                placeholder="api://<api-id>/.default"
                value={form.oauth2.scope}
                onChange={(event) => updateOAuth2({ scope: event.target.value })}
              />
            </label>
          </div>
        )}
      </div>
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
