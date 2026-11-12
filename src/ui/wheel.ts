/**
 * Wheel input as picture steps. A mouse wheel notch is one step. A trackpad sends a stream of small deltas for one
 * swipe, and then more from its inertia: they are added up until they make a step, and after a step the rest of that
 * swipe is ignored (until the stream pauses), so one swipe moves one picture rather than twenty.
 */
export const LINE_PX = 40, PAGE_PX = 800;

/** A wheel event's vertical movement in CSS pixels, whatever its delta mode. */
export const wheelPixels = (deltaY: number, deltaMode: number): number => (deltaMode === 1 ? deltaY * LINE_PX : deltaMode === 2 ? deltaY * PAGE_PX : deltaY);

/** Whether an event looks like a mouse wheel notch (lines or pages, or a whole pixel step of 100 or more) rather than a trackpad's stream. */
export const isNotch = (deltaY: number, deltaMode: number): boolean => deltaMode !== 0 || (Math.abs(deltaY) >= 100 && Number.isInteger(deltaY));

export class WheelStepper {
  private acc = 0; private last = -Infinity; private lockedUntilPause = false;
  /** Pause (ms) that ends a trackpad swipe; the distance (px) that makes a step. */
  constructor(private pause = 180, private threshold = 60) {}
  /** -1, 0 or 1: the step this event makes, at time `now` (ms). */
  step(deltaY: number, deltaMode: number, now: number): -1 | 0 | 1 {
    const px = wheelPixels(deltaY, deltaMode), gap = now - this.last;
    this.last = now;
    if (isNotch(deltaY, deltaMode)) { this.acc = 0; this.lockedUntilPause = false; return px > 0 ? 1 : px < 0 ? -1 : 0; }
    if (gap > this.pause) { this.acc = 0; this.lockedUntilPause = false; } // a new swipe
    if (this.lockedUntilPause) return 0;
    if (this.acc && Math.sign(px) !== Math.sign(this.acc)) this.acc = 0;   // the swipe turned round
    this.acc += px;
    if (Math.abs(this.acc) < this.threshold) return 0;
    const s = this.acc > 0 ? 1 : -1; this.acc = 0; this.lockedUntilPause = true;
    return s;
  }
}

/** The zoom factor for a wheel or pinch event: proportional to its movement, so a pinch's many small events zoom smoothly instead of 10 % each. */
export const wheelZoomFactor = (deltaY: number, deltaMode: number): number => Math.exp(-Math.max(-300, Math.min(300, wheelPixels(deltaY, deltaMode))) * 0.0015);
