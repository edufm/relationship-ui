import { SUN_RADIUS } from '../geometry/ring';

/** The dataset itself, rendered as the sun at the center of the system — no orbit of its own. */
export function Sun({ name }: { name: string }) {
  return (
    <g className="sun">
      <circle className="sun-halo" r={SUN_RADIUS + 22} />
      <circle className="sun-circle" r={SUN_RADIUS} />
      <text className="sun-label" textAnchor="middle" dominantBaseline="middle">
        {name}
      </text>
    </g>
  );
}
