export type Easing = (t: number) => number;

export const easeOutCubic: Easing = (t) => 1 - Math.pow(1 - t, 3);

export interface TweenHandle {
  cancel: () => void;
}

/** RAF-based tween of a single numeric value, interruptible via `.cancel()`. */
export function animateValue(
  from: number,
  to: number,
  durationMs: number,
  onUpdate: (value: number) => void,
  onComplete?: () => void,
  easing: Easing = easeOutCubic,
): TweenHandle {
  let cancelled = false;
  const start = performance.now();

  function frame(now: number) {
    if (cancelled) return;
    const elapsed = now - start;
    const t = durationMs <= 0 ? 1 : Math.min(1, elapsed / durationMs);
    const value = from + (to - from) * easing(t);
    onUpdate(value);
    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      onComplete?.();
    }
  }

  requestAnimationFrame(frame);
  return {
    cancel: () => {
      cancelled = true;
    },
  };
}
