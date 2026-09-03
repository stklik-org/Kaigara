// Shared between TimelineView (the actual <Timeline>) and ExpectedRequestsChart (the overlay
// below it), so the chart's x-axis can use the exact same seconds-per-pixel scale and stay
// pixel-aligned with the timeline above it.
export const SCALE_SECONDS = 60; // one major tick = 1 minute
export const SCALE_WIDTH_MIN = 40;
export const SCALE_WIDTH_MAX = 260;
export const SCALE_WIDTH_STEP = 30;
export const SCALE_WIDTH_DEFAULT = 100;

// Width of the track-name column (TimelineView's TrackLabelSidebar, and the matching y-axis gutter
// in ExpectedRequestsChart so the two stay x-aligned). User-resizable via the seam handle in
// TimelineView; the value lives in ComposePage so both consumers read the same number.
export const SIDEBAR_WIDTH_MIN = 120;
export const SIDEBAR_WIDTH_MAX = 360;
export const SIDEBAR_WIDTH_DEFAULT = 180;
