import test from "node:test";
import assert from "node:assert/strict";

import {
  Load,
  LoadTimeline,
  ConstantShape,
  RequestComposition,
  Track,
  TRACK_COLOR_PALETTE,
  TRACK_PALETTE_MIN_CONTRAST,
  TRACK_PALETTE_SURFACES,
  assignTrackColors,
  parseLoadTimeline,
  withAssignedTrackColors,
} from "../src/index.ts";

function track(id: string, color?: string): Track {
  return new Track({ id, label: id, color, loads: [] });
}

function colorsOf(tracks: Track[]): (string | undefined)[] {
  return tracks.map((t) => t.color);
}

// --- the palette itself ------------------------------------------------------------------

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The palette moved from per-theme CSS variables into the document, so one value now has to work
 *  on both surfaces. This is the check that makes that claim true rather than aspirational. */
test("every palette colour is legible on both the light and the dark surface", () => {
  for (const color of TRACK_COLOR_PALETTE) {
    assert.match(color, /^#[0-9a-f]{6}$/, `${color} must be a literal lowercase hex`);
    for (const [theme, surface] of Object.entries(TRACK_PALETTE_SURFACES)) {
      const ratio = contrast(color, surface);
      assert.ok(
        ratio >= TRACK_PALETTE_MIN_CONTRAST,
        `${color} contrasts ${ratio.toFixed(2)}:1 against the ${theme} surface ${surface}, below ${TRACK_PALETTE_MIN_CONTRAST}:1`,
      );
    }
  }
});

test("the palette has no duplicate entries", () => {
  assert.equal(new Set(TRACK_COLOR_PALETTE).size, TRACK_COLOR_PALETTE.length);
});

// --- assignment --------------------------------------------------------------------------

test("uncoloured tracks are coloured in palette order", () => {
  const assigned = assignTrackColors([track("a"), track("b"), track("c")]);
  assert.deepEqual(colorsOf(assigned), TRACK_COLOR_PALETTE.slice(0, 3));
});

test("colours already on the timeline are kept and never handed out again", () => {
  const pinned = TRACK_COLOR_PALETTE[1];
  const assigned = assignTrackColors([track("a"), track("b", pinned), track("c")]);

  assert.equal(assigned[1].color, pinned, "an existing colour must survive untouched");
  assert.equal(new Set(colorsOf(assigned)).size, 3, "no two tracks may share a colour");
  assert.ok(!colorsOf(assigned).filter((_, i) => i !== 1).includes(pinned));
});

test("a user's custom colour is respected even though it is not in the palette", () => {
  const assigned = assignTrackColors([track("a", "#123456"), track("b")]);
  assert.equal(assigned[0].color, "#123456");
  assert.equal(assigned[1].color, TRACK_COLOR_PALETTE[0]);
});

test("case differences do not let the same colour be assigned twice", () => {
  const assigned = assignTrackColors([track("a", TRACK_COLOR_PALETTE[0].toUpperCase()), track("b")]);
  assert.notEqual(assigned[1].color?.toLowerCase(), TRACK_COLOR_PALETTE[0].toLowerCase());
});

test("more tracks than colours keeps colouring them, rotating rather than giving up", () => {
  const many = Array.from({ length: TRACK_COLOR_PALETTE.length + 3 }, (_, i) => track(`t${i}`));
  const assigned = assignTrackColors(many);

  assert.ok(assigned.every((t) => !!t.color), "every track must end up with a colour");
  assert.deepEqual(colorsOf(assigned).slice(0, TRACK_COLOR_PALETTE.length), [...TRACK_COLOR_PALETTE]);
  assert.deepEqual(colorsOf(assigned).slice(TRACK_COLOR_PALETTE.length), TRACK_COLOR_PALETTE.slice(0, 3));
});

test("assignment does not mutate the tracks it was given", () => {
  const original = track("a");
  assignTrackColors([original]);
  assert.equal(original.color, undefined);
});

test("assignment produces real Track instances, not plain objects", () => {
  const [assigned] = assignTrackColors([
    new Track({
      id: "a",
      label: "A",
      loads: [
        new Load({
          id: "l1",
          startSeconds: 0,
          durationSeconds: 10,
          shape: new ConstantShape({ ratePerSec: 5 }),
          requests: RequestComposition.empty(),
        }),
      ],
    }),
  ]);
  assert.ok(assigned instanceof Track);
  assert.ok(assigned.loads[0] instanceof Load, "nested Loads must keep their prototypes too");
  assert.equal(assigned.loads[0].shape.rateAt(1, 10), 5);
});

// --- timeline-level helper and persistence ------------------------------------------------

test("withAssignedTrackColors returns the same instance when nothing is missing", () => {
  const timeline = new LoadTimeline({
    totalDurationSeconds: 60,
    tracks: [track("a", TRACK_COLOR_PALETTE[0])],
  });
  assert.equal(withAssignedTrackColors(timeline), timeline);
});

test("an assigned colour survives serialization and reparsing", () => {
  const timeline = withAssignedTrackColors(
    new LoadTimeline({ totalDurationSeconds: 60, tracks: [track("a"), track("b")] }),
  );

  const json = JSON.parse(JSON.stringify(timeline));
  assert.deepEqual(
    json.tracks.map((t: { color?: string }) => t.color),
    TRACK_COLOR_PALETTE.slice(0, 2),
    "the colour has to be in the serialized document, not just on the instance",
  );

  // And the document it produces is one the validator accepts.
  assert.deepEqual(colorsOf(parseLoadTimeline(json).tracks), TRACK_COLOR_PALETTE.slice(0, 2));
});
