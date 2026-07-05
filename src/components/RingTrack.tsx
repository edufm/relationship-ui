import { useRef, useState, type PointerEvent, type RefObject } from 'react';
import { useOrbit } from '../state/OrbitContext';
import { BASE_RADIUS, RING_GAP, radiusForIndex } from '../geometry/ring';
import { clientToLocalPoint } from '../geometry/pointer';
import { PLANET_RADIUS } from './Planet';

interface RingTrackProps {
  typeId: string;
  index: number;
  label: string;
  svgRef: RefObject<SVGSVGElement | null>;
}

const LABEL_HIT_WIDTH = 116;
const LABEL_HIT_HEIGHT = 30;
/** Gap between the label's right edge and the selected planet's left edge, along the axis. */
const LABEL_PLANET_GAP = 12;

/**
 * The static circular track behind a ring's planets, plus the ring's type label sitting on the
 * central reference axis, just before the ring's selected planet. Both act as radial drag
 * handles: pulling one toward a neighboring ring swaps the two rings' order. The label is the
 * dependable handle — with neighborhood borrowing the track is usually covered end-to-end by
 * planets, which capture the pointer before it.
 */
export function RingTrack({ typeId, index, label, svgRef }: RingTrackProps) {
  const { state, dispatch } = useOrbit();
  const radius = radiusForIndex(index);
  const [dragRadius, setDragRadius] = useState<number | null>(null);
  const dragStart = useRef<{ pointerMeasure: number; radiusStart: number; mode: 'track' | 'label' } | null>(null);

  /** How far from the center the pointer is, in the units the active handle drags in: true radius
   * for the track, plain x for the label (which lives at the top edge, where hypot would be wrong). */
  function measure(e: PointerEvent, mode: 'track' | 'label'): number | null {
    if (!svgRef.current) return null;
    const local = clientToLocalPoint(svgRef.current, e.clientX, e.clientY);
    return mode === 'track' ? Math.hypot(local.x, local.y) : local.x;
  }

  function beginDrag(e: PointerEvent, mode: 'track' | 'label') {
    e.stopPropagation();
    const pointerMeasure = measure(e, mode);
    if (pointerMeasure == null) return;
    dragStart.current = { pointerMeasure, radiusStart: radius, mode };
    setDragRadius(radius);
    dispatch({ type: 'BEGIN_REORDER', typeId, pointerRadius: pointerMeasure });
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: PointerEvent) {
    if (!dragStart.current) return;
    const pointerMeasure = measure(e, dragStart.current.mode);
    if (pointerMeasure == null) return;
    const delta = pointerMeasure - dragStart.current.pointerMeasure;
    setDragRadius(Math.max(0, dragStart.current.radiusStart + delta));
  }

  function handlePointerUp() {
    if (!dragStart.current) return;
    const finalRadius = dragRadius ?? radius;
    const currentIndex = state.ringOrder.indexOf(typeId);
    // Nearest ring slot to where the drag was released — any number of levels away, not just a
    // neighbor. The reducer moves the ring there and slides the ones in between.
    const nearestSlot = Math.round((finalRadius - BASE_RADIUS) / RING_GAP);
    const targetIndex = Math.max(0, Math.min(state.ringOrder.length - 1, nearestSlot));

    dispatch({ type: 'REORDER_COMMIT', fromIndex: currentIndex, toIndex: targetIndex });
    dragStart.current = null;
    setDragRadius(null);
  }

  const displayRadius = dragRadius ?? radius;
  const labelX = displayRadius - PLANET_RADIUS - LABEL_PLANET_GAP;

  return (
    <g className="ring-track">
      <circle className="ring-track-visual" r={displayRadius} />
      <circle
        className="ring-track-hit"
        r={displayRadius}
        onPointerDown={(e) => beginDrag(e, 'track')}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
      <g
        className="ring-label-handle"
        onPointerDown={(e) => beginDrag(e, 'label')}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <rect
          className="ring-label-hit"
          x={labelX - LABEL_HIT_WIDTH}
          y={-LABEL_HIT_HEIGHT + 4}
          width={LABEL_HIT_WIDTH}
          height={LABEL_HIT_HEIGHT}
        />
        <text className="ring-type-label" x={labelX} y={-8} textAnchor="end">
          {label}
        </text>
        <g
          className="ring-hide-button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => dispatch({ type: 'HIDE_RING', typeId })}
        >
          <title>Ocultar órbita</title>
          <circle className="ring-hide-hit" cx={labelX - 8} cy={14} r={9} />
          <text className="ring-hide-glyph" x={labelX - 8} y={18} textAnchor="middle">
            ×
          </text>
        </g>
      </g>
    </g>
  );
}
