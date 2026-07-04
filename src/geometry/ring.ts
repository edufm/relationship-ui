export const BASE_RADIUS = 60;
export const RING_GAP = 130;
/** Desired arc-length (px) between adjacent items on any ring, regardless of its radius or candidate count. Keeping this fixed (instead of spreading N items evenly around a full circle) is what keeps sparse rings from looking empty and dense rings from looking crowded. */
export const ARC_SPACING = 90;

export function radiusForIndex(index: number): number {
  return BASE_RADIUS + index * RING_GAP;
}

/** Angular spacing (radians) between adjacent items on a ring of this radius, for a constant on-screen arc spacing. */
export function angleStepForRadius(radius: number): number {
  return ARC_SPACING / radius;
}

export function polarToCartesian(radius: number, angle: number): { x: number; y: number } {
  return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
}

/** Wraps `value` into (-modulus/2, modulus/2] — the representative of its residue class closest to 0. */
export function centeredMod(value: number, modulus: number): number {
  if (modulus <= 0) return 0;
  let v = value % modulus;
  if (v > modulus / 2) v -= modulus;
  if (v <= -modulus / 2) v += modulus;
  return v;
}

/** Shortest signed angular distance from `a` to `b`, wrapped to (-PI, PI]. */
export function angularDistance(a: number, b: number): number {
  return centeredMod(b - a, 2 * Math.PI);
}

export function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}
