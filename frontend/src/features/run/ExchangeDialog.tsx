import Editor from "@monaco-editor/react";
import { EXCHANGE_CAPTURE_CAP, type RunExchange } from "@kaigara/shared-types";
import { useTheme } from "@/app/ThemeContext";
import { Panel } from "@/components/ui/Panel";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const scaled = bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${scaled} (${bytes.toLocaleString("en")} B)`;
}

/** A JSON body pretty-printed; anything else — including JSON cut off by the capture cap, which no
 *  longer parses — verbatim, still highlighted as JSON if it starts like it. */
function presentBody(text: string): { value: string; language: "json" | "plaintext" } {
  const trimmed = text.trim();
  try {
    return { value: JSON.stringify(JSON.parse(trimmed), null, 2), language: "json" };
  } catch {
    return { value: text, language: trimmed.startsWith("{") || trimmed.startsWith("[") ? "json" : "plaintext" };
  }
}

function statusTone(status: number): string {
  if (status === 0) return "text-ink-muted";
  if (status < 300) return "text-status-pass";
  if (status < 400) return "text-ink-muted";
  return "text-status-fail";
}

function ExchangePanel({
  label,
  meta,
  body,
  bytes,
  truncated,
  modelPath,
}: {
  label: string;
  meta: string;
  body: string;
  bytes: number;
  truncated: boolean;
  modelPath: string;
}) {
  const { theme } = useTheme();
  const { value, language } = presentBody(body);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex-none border-b border-border bg-surface-sunken px-3 py-1.5">
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] font-semibold tracking-wide text-ink-muted uppercase">{label}</span>
          <span className="ml-auto font-mono text-[11px] text-ink" title="Size of the body as sent or received">
            {formatSize(bytes)}
          </span>
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-ink" title={meta}>
          {meta}
        </div>
      </div>
      {body.trim() === "" ? (
        <div className="p-3 font-mono text-[11px] text-ink-muted">(empty body)</div>
      ) : (
        // Read-only, so Monaco draws no validation squiggles — a body cut off by the cap would
        // otherwise end in a red one.
        <div className="min-h-0 flex-1">
          <Editor
            path={modelPath}
            language={language}
            value={value}
            theme={theme === "dark" ? "vs-dark" : "vs"}
            options={{
              readOnly: true,
              minimap: { enabled: false },
              fontSize: 12,
              wordWrap: "on",
              scrollBeyondLastLine: false,
              automaticLayout: true,
              lineNumbersMinChars: 3,
            }}
          />
        </div>
      )}
      {truncated && (
        <div className="flex-none border-t border-border bg-status-warn-bg px-3 py-1 text-[10.5px] text-status-warn">
          Showing the first {EXCHANGE_CAPTURE_CAP.toLocaleString("en")} characters of {formatSize(bytes)}. This run kept
          bodies up to 64 KB — set “Exchange capture” in Compose to keep them complete.
        </div>
      )}
    </div>
  );
}

/**
 * "Open this row"'s popup: the literal request and response `RequestResponseView` captured for one
 * clicked table row, side by side rather than tabbed — the whole point of a benchmarking tool's
 * inspector is comparing what was sent against what came back, which a tab hides one half of at a
 * time. JSON bodies open in a read-only Monaco view: folding, highlighting and search.
 */
export function ExchangeDialog({
  loading,
  error,
  exchange,
  onClose,
}: {
  loading: boolean;
  error: string | null;
  exchange: RunExchange | null;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="presentation" onClick={onClose}>
      <Panel
        role="dialog"
        aria-modal="true"
        aria-label="Request and response"
        className="flex h-[80vh] w-full max-w-6xl flex-col overflow-hidden p-0"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex flex-none items-center gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-ink">Request &amp; response</div>
            {exchange && (
              <div className="truncate font-mono text-[11px] text-ink-muted">
                {exchange.method} {exchange.url}
              </div>
            )}
          </div>
          {exchange && (
            <span className={`flex-none font-mono text-sm font-semibold ${statusTone(exchange.status)}`}>
              {exchange.status === 0 ? "no response" : exchange.status}
            </span>
          )}
          <button type="button" onClick={onClose} title="Close" aria-label="Close" className="flex-none text-ink-muted hover:text-ink">
            ✕
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          {loading && <div className="flex-1 p-4 text-center text-[12px] text-ink-muted">Loading…</div>}
          {error && <div className="flex-1 p-4 text-center text-[12px] text-status-fail">{error}</div>}
          {exchange && (
            <>
              <ExchangePanel
                label="Request"
                meta={`${exchange.method} ${exchange.url}`}
                body={exchange.requestBody}
                bytes={exchange.requestBytes}
                truncated={exchange.requestTruncated}
                modelPath="exchange/request"
              />
              <div className="w-px flex-none bg-border" />
              <ExchangePanel
                label="Response"
                meta={exchange.status === 0 ? "no response" : `HTTP ${exchange.status}`}
                body={exchange.responseBody}
                bytes={exchange.responseBytes}
                truncated={exchange.responseTruncated}
                modelPath="exchange/response"
              />
            </>
          )}
        </div>
      </Panel>
    </div>
  );
}
