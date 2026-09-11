/**
 * Geometry shared by everything that has to line up with the `<Timeline>` canvas: the Compose
 * timeline, its track-label sidebar, the Expected Requests overlay chart below it, and the Run
 * screen's read-only timeline. A number that only one of them uses does not belong here — one that
 * two of them must agree on does, because "pixel-aligned" here means "computed from the same
 * constant", not "looks right on my screen".
 */

/** Seconds per major tick — one minute. */
export const SCALE_SECONDS = 60;

/** Px width of one major tick: the zoom level. */
export const SCALE_WIDTH_MIN = 40;
export const SCALE_WIDTH_MAX = 260;
export const SCALE_WIDTH_STEP = 30;
export const SCALE_WIDTH_DEFAULT = 100;

/** Width of the track-name column — TimelineView's TrackLabelSidebar, and the matching y-axis
 *  gutter in ExpectedRequestsChart so the two stay x-aligned. User-resizable via the seam handle;
 *  the live value lives in ComposePage so both consumers read the same number. */
export const SIDEBAR_WIDTH_MIN = 120;
export const SIDEBAR_WIDTH_MAX = 360;
export const SIDEBAR_WIDTH_DEFAULT = 180;

/** Height of one track row on the Compose canvas. */
export const ROW_HEIGHT = 44;
/** Taller on the Run screen: its rows carry a second line of live progress text. */
export const RUN_ROW_HEIGHT = 64;

/** Matches `.timeline-editor-time-area`'s own hardcoded height in the library's stylesheet. It is
 *  not configurable via props, so our label sidebar's header has to match it by hand. */
export const TIME_AREA_HEIGHT = 32;

/** Left inset before the t=0 gridline, px. This is the library's own default, passed back to it
 *  explicitly so the end-of-timeline marker can use the same time→pixel mapping the library uses
 *  to place actions: `pixelX = TIMELINE_START_LEFT + (seconds / scale) * scaleWidth`. */
export const TIMELINE_START_LEFT = 20;
