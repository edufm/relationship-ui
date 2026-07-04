import { useRef, useState, type PointerEvent, type RefObject } from 'react';
import { useOrbit } from '../state/OrbitContext';
import { radiusForIndex } from '../geometry/ring';
import { clientToLocalPoint } from '../geometry/pointer';

interface RingTrackProps {
  typeId: string;
  index: number;
  svgRef: RefObject<SVGSVGElement | null>;
}

/** The static circular track behind a ring's planets. Grabbing empty track (not a planet) lets the user drag the ring radially to swap its order with a neighboring ring. */
export function RingTrack({ typeId, index, svgRef }: RingTrackProps) {
  const { state, dispatch } = useOrbit();
  const radius = radiusForIndex(index);
  const [dragRadius, setDragRadius] = useState<number | null>(null);
  const dragStart = useRef<{ pointerRadius: number; radiusStart: number } | null>(null);

  function handlePointerDown(e: PointerEvent<SVGCircleElement>) {
    e.stopPropagation();
    if (!svgRef.current) return;
    const local = clientToLocalPoint(svgRef.current, e.clientX, e.clientY);
    const pointerRadius = Math.hypot(local.x, local.y);
    dragStart.current = { pointerRadius, radiusStart: radius };
    setDragRadius(radius);
    dispatch({ type: 'BEGIN_REORDER', typeId, pointerRadius });
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: PointerEvent<SVGCircleElement>) {
    if (!dragStart.current || !svgRef.current) return;
    const local = clientToLocalPoint(svgRef.current, e.clientX, e.clientY);
    const pointerRadius = Math.hypot(local.x, local.y);
    const delta = pointerRadius - dragStart.current.pointerRadius;
    setDragRadius(Math.max(0, dragStart.current.radiusStart + delta));
  }

  function handlePointerUp() {
    if (!dragStart.current) return;
    const finalRadius = dragRadius ?? radius;
    const currentIndex = state.ringOrder.indexOf(typeId);
    let targetIndex = currentIndex;

    const prevIndex = currentIndex - 1;
    if (prevIndex >= 0) {
      const midpoint = (radiusForIndex(prevIndex) + radius) / 2;
      if (finalRadius < midpoint) targetIndex = prevIndex;
    }
    const nextIndex = currentIndex + 1;
    if (nextIndex < state.ringOrder.length) {
      const midpoint = (radius + radiusForIndex(nextIndex)) / 2;
      if (finalRadius > midpoint) targetIndex = nextIndex;
    }

    dispatch({ type: 'REORDER_COMMIT', fromIndex: currentIndex, toIndex: targetIndex });
    dragStart.current = null;
    setDragRadius(null);
  }

  const displayRadius = dragRadius ?? radius;

  return (
    <g className="ring-track">
      <circle className="ring-track-visual" r={displayRadius} />
      <circle
        className="ring-track-hit"
        r={displayRadius}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
    </g>
  );
}
