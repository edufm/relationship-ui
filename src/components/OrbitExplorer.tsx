import { useEffect, useRef, useState } from 'react';
import { useOrbit } from '../state/OrbitContext';
import { radiusForIndex } from '../geometry/ring';
import { ReferenceAxis } from './ReferenceAxis';
import { RingTrack } from './RingTrack';
import { RingGroup } from './RingGroup';
import { Sun } from './Sun';

const LEFT_MARGIN = 140;
const CLIP_ID = 'orbit-viewport-clip';

function useViewportSize() {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    function handleResize() {
      setSize({ width: window.innerWidth, height: window.innerHeight });
    }
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  return size;
}

export function OrbitExplorer() {
  const { state, dataset } = useOrbit();
  const svgRef = useRef<SVGSVGElement>(null);
  const { width, height } = useViewportSize();
  const halfHeight = height / 2;

  return (
    <svg
      ref={svgRef}
      className="orbit-explorer"
      width={width}
      height={height}
      viewBox={`${-LEFT_MARGIN} ${-halfHeight} ${width} ${height}`}
      role="img"
      aria-label="Explorador de órbitas"
    >
      <defs>
        <clipPath id={CLIP_ID}>
          <rect x={-LEFT_MARGIN} y={-halfHeight} width={width} height={height} />
        </clipPath>
      </defs>

      <rect
        className="orbit-frame"
        x={-LEFT_MARGIN + 1}
        y={-halfHeight + 1}
        width={width - 2}
        height={height - 2}
      />

      <g clipPath={`url(#${CLIP_ID})`}>
        <ReferenceAxis ringRadii={state.ringOrder.map((_, i) => radiusForIndex(i))} maxRadius={width - LEFT_MARGIN} />
        <Sun name={dataset.name} />
        {state.ringOrder.map((typeId, index) => {
          const entityType = dataset.entityTypes.find((t) => t.id === typeId);
          const label = entityType?.label ?? typeId;
          return (
            <g key={typeId} className="ring" data-type-id={typeId}>
              <RingTrack typeId={typeId} index={index} label={label} svgRef={svgRef} />
              <RingGroup
                typeId={typeId}
                index={index}
                label={label}
                viewportHalfHeight={halfHeight}
                svgRef={svgRef}
              />
            </g>
          );
        })}
      </g>
    </svg>
  );
}
