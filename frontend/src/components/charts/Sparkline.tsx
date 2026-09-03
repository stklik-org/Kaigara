import { extent, scaleLinear } from "./scale";

export function Sparkline({ values, className = "" }: { values: number[]; className?: string }) {
  const [min, max] = extent(values);
  const x = scaleLinear([0, Math.max(values.length - 1, 1)], [0, 300]);
  const y = scaleLinear([min, max], [82, 8]);
  const points = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");

  return (
    <svg viewBox="0 0 300 90" preserveAspectRatio="none" className={className}>
      <polyline points={points} className="fill-none stroke-accent" strokeWidth={2} />
    </svg>
  );
}
