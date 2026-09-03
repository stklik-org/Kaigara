import type { ReactNode } from "react";

export function Chip({ active = false, children }: { active?: boolean; children: ReactNode }) {
  return (
    <span
      className={`inline-flex w-fit items-center rounded-full border px-3 py-1 text-xs font-medium ${
        active ? "border-accent bg-accent text-white" : "border-border-strong text-ink-muted"
      }`}
    >
      {children}
    </span>
  );
}
