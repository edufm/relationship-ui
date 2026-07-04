const TICK_LENGTH = 6;
const ARROW_SIZE = 6;

/** The fixed selection axis running through every ring, styled like an orrery pointer: a hairline with a small perpendicular tick where it crosses each ring, and an arrowhead at its tip. */
export function ReferenceAxis({ maxRadius, ringRadii }: { maxRadius: number; ringRadii: number[] }) {
  return (
    <g className="reference-axis">
      <line className="reference-axis-line" x1={0} y1={0} x2={maxRadius} y2={0} />
      {ringRadii.map((r) => (
        <line
          key={r}
          className="reference-axis-tick"
          x1={r}
          y1={-TICK_LENGTH}
          x2={r}
          y2={TICK_LENGTH}
        />
      ))}
      <polygon
        className="reference-axis-head"
        points={`${maxRadius},0 ${maxRadius - ARROW_SIZE},${-ARROW_SIZE / 2} ${maxRadius - ARROW_SIZE},${ARROW_SIZE / 2}`}
      />
    </g>
  );
}
