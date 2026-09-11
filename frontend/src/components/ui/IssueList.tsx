import type { ValidationIssue } from "@kaigara/shared-types";

/** How many issues are spelled out before the rest collapse into a "+ N more" line — enough to see
 *  a pattern, not enough to bury the page under a document that is wrong in one systematic way. */
export const MAX_LISTED_ISSUES = 6;

/** A validator's per-path issues, as the Load screen shows them: one line per issue, the JSON path
 *  in mono ahead of the message. The same list appears for a dropped file that would not parse and
 *  for a library entry that could not be read — one component so the two cannot drift apart.
 *
 *  The Compose Code view has its own denser, per-severity variant in its status bar; that one is
 *  deliberately not this component, because it colours each row by severity and lives in a strip
 *  two lines tall rather than in a panel. */
export function IssueList({ issues }: { issues: Pick<ValidationIssue, "path" | "message">[] }) {
  return (
    <ul className="mt-2 space-y-1">
      {issues.slice(0, MAX_LISTED_ISSUES).map((issue, index) => (
        <li key={`${issue.path}-${index}`} className="text-xs text-ink-muted">
          <span className="font-mono text-ink">{issue.path || "<root>"}</span> — {issue.message}
        </li>
      ))}
      {issues.length > MAX_LISTED_ISSUES && (
        <li className="text-xs text-ink-muted">+ {issues.length - MAX_LISTED_ISSUES} more</li>
      )}
    </ul>
  );
}
