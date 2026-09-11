import type { ConnectionTestResult } from "@kaigara/shared-types";
import { Badge, type BadgeTone } from "@/components/ui/Badge";

/** A probe that reached the server but found no ServiceDescription is a warning, not a pass: the
 *  server answers, but Kaigara cannot tell which conformance profiles it implements. A probe that
 *  never ran is a warning too — it says nothing about the target either way. */
function resultTone(result: ConnectionTestResult): BadgeTone {
  if (!result.reachable) return result.error?.kind === "probe-unavailable" ? "warn" : "fail";
  return result.profiles ? "pass" : "warn";
}

function resultLabel(result: ConnectionTestResult): string {
  if (result.reachable) return "Reachable";
  return result.error?.kind === "probe-unavailable" ? "Probe failed" : "Unreachable";
}

/** "…/AssetAdministrationShellRepositoryServiceSpecification/SSP-002" → "AAS Repository SSP-002" */
function shortProfileLabel(profile: string): string {
  const segments = profile.split("/").filter(Boolean);
  const ssp = segments.at(-1) ?? profile;
  const spec = (segments.at(-2) ?? "")
    .replace(/ServiceSpecification$/, "")
    .replace(/^AssetAdministrationShell/, "AAS ")
    .replace(/([a-z])([A-Z])/g, "$1 $2");
  return spec ? `${spec.trim()} ${ssp}` : ssp;
}

/** What the last probe found, under the connection it was run against: the verdict, the exact
 *  request that produced it, and the conformance profiles the server advertises. The request line
 *  is spelled out because "unreachable" is only useful next to what was actually asked for. */
export function ConnectionTestResultView({ result }: { result: ConnectionTestResult }) {
  return (
    <div className="mt-3 space-y-2 border-t border-border pt-3">
      <div className="flex items-start gap-2">
        <span className="flex-none whitespace-nowrap">
          <Badge tone={resultTone(result)}>{resultLabel(result)}</Badge>
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
