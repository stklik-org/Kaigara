import type { ReactElement, SVGProps } from "react";

export type Glyph = (props: SVGProps<SVGSVGElement>) => ReactElement;

const glyphBase: SVGProps<SVGSVGElement> = {
  viewBox: "0 0 12 12",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

export const RampUpGlyph: Glyph = (props) => (
  <svg {...glyphBase} {...props}>
    <path d="M1.5 10 L10.5 2" />
  </svg>
);

export const RampDownGlyph: Glyph = (props) => (
  <svg {...glyphBase} {...props}>
    <path d="M1.5 2 L10.5 10" />
  </svg>
);

export const SineGlyph: Glyph = (props) => (
  <svg {...glyphBase} {...props}>
    <path d="M1 6 Q3.25 1 5.5 6 T10 6" />
  </svg>
);

export const BellGlyph: Glyph = (props) => (
  <svg {...glyphBase} {...props}>
    <path d="M1 9.5 Q4 9.5 5 2.5 Q6 9.5 11 9.5" />
  </svg>
);

export const SpikeGlyph: Glyph = (props) => (
  <svg {...glyphBase} {...props}>
    <path d="M6 1.5 L10.5 10 L1.5 10 Z" />
  </svg>
);

export const ConstantGlyph: Glyph = (props) => (
  <svg {...glyphBase} {...props}>
    <path d="M1 6 L11 6" />
  </svg>
);

export const IndividualGlyph: Glyph = (props) => (
  <svg {...glyphBase} {...props}>
    <circle cx="6" cy="6" r="2.25" fill="currentColor" stroke="none" />
  </svg>
);
