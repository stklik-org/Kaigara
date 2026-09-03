import type { HTMLAttributes, ReactNode } from "react";

/** Bordered container — the wireframe's "box"/"box-solid" primitive. `dashed` marks an
 *  empty/placeholder affordance (e.g. "+ new step"), matching the wireframe's dashed-vs-solid
 *  convention for real vs. not-yet-populated content. */
export function Panel({
  dashed = false,
  className = "",
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { dashed?: boolean }) {
  return (
    <div
      className={`rounded-lg border bg-surface ${dashed ? "border-dashed border-border-strong" : "border-border"} ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="text-[13px] font-semibold tracking-wide text-ink-muted uppercase">{children}</div>;
}
