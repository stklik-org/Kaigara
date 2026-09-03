import type { ReactNode } from "react";

export type BadgeTone = "pass" | "fail" | "warn" | "neutral";

const TONE_CLASSES: Record<BadgeTone, string> = {
  pass: "border-status-pass bg-status-pass-bg text-status-pass",
  fail: "border-status-fail bg-status-fail-bg text-status-fail",
  warn: "border-status-warn bg-status-warn-bg text-status-warn",
  neutral: "border-border-strong bg-surface-sunken text-ink-muted",
};

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex w-fit items-center rounded border px-2 py-0.5 text-[13px] font-semibold ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}
