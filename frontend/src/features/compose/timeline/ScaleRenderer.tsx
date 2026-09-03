import { formatMMSS } from "./formatTime";

/** `getScaleRender` for <Timeline> — `scale` here is a raw tick value in the same units as
 *  Load.startSeconds (we pass `scale={60}` to <Timeline>, i.e. one major tick per minute). */
export function renderScale(scale: number) {
  return <>{formatMMSS(scale)}</>;
}
