import { useMemo, useRef, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { useOrbit } from '../state/OrbitContext';
import { buildRingDisplayList } from '../model/selectors';
import { angleStepForRadius, angularDistance, polarToCartesian, radiusForIndex } from '../geometry/ring';
import { clientToLocalPoint } from '../geometry/pointer';
import { animateValue, type TweenHandle } from '../geometry/tween';
import { Planet, PLANET_RADIUS } from './Planet';

const SNAP_DURATION_MS = 180;
/** How far beyond the visible frame we still render candidates, as a multiple of the frame's half-height — lets them fade out instead of popping out of existence right at the edge. */
const FADE_RENDER_REACH = 1.6;
/** Opacity floor for candidates near the edge of that fade zone. */
const FADE_MIN_OPACITY = 0.16;

interface RingGroupProps {
  typeId: string;
  index: number;
  label: string;
  viewportHalfHeight: number;
  svgRef: RefObject<SVGSVGElement | null>;
}

/**
 * The rotating ring of planets for one entity type. Candidates are laid out at a fixed angular
 * step (not evenly divided across the full circle) and, when the selected parent alone doesn't
 * have enough children to fill the visible window, the list borrows entities from the parent's
 * neighboring entities above/below — so the ring never looks emptier than it has to. Dragging
 * anywhere on it rotates the ring; on release it snaps so the nearest candidate lands on the
 * shared reference axis.
 */
export function RingGroup({ typeId, index, label, viewportHalfHeight, svgRef }: RingGroupProps) {
  const { state, dataset, dispatch } = useOrbit();
  const radius = radiusForIndex(index);
  const angleStep = angleStepForRadius(radius);
  const rotation = state.rotation[typeId] ?? 0;
  const selectedId = state.selected[typeId] ?? null;

  const verticalReach = viewportHalfHeight + PLANET_RADIUS;
  const renderReach = verticalReach * FADE_RENDER_REACH;
  const halfWindow =
    radius <= renderReach
      ? Math.max(1, Math.floor(Math.PI / angleStep))
      : Math.ceil(Math.asin(Math.min(1, renderReach / radius)) / angleStep) + 1;

  const displayList = useMemo(
    () => buildRingDisplayList(dataset, state.ringOrder, state.selected, index, halfWindow),
    [dataset, state.ringOrder, state.selected, index, halfWindow],
  );
  const { entities, originOffset } = displayList;

  const lastPointerAngleRef = useRef(0);
  const liveRotationRef = useRef(rotation);
  const draggingRef = useRef(false);
  const tweenRef = useRef<TweenHandle | null>(null);
  liveRotationRef.current = rotation;

  const visiblePlanets = useMemo(() => {
    const result: { entity: (typeof entities)[number]; x: number; y: number; opacity: number }[] = [];
    for (let i = 0; i < entities.length; i++) {
      // Absolute slot (i - originOffset, stable) plus the ring's live rotation is what actually
      // moves entities as you drag — see buildRingDisplayList for why the origin itself must stay
      // fixed to the currently-selected entity.
      const absoluteSlot = i - originOffset;
      const visualSlot = absoluteSlot + rotation / angleStep;
      if (Math.abs(visualSlot) > halfWindow) continue;
      const { x, y } = polarToCartesian(radius, visualSlot * angleStep);
      const distanceRatio = Math.min(1, Math.abs(y) / verticalReach);
      const opacity = 1 - distanceRatio * (1 - FADE_MIN_OPACITY);
      result.push({ entity: entities[i], x, y, opacity });
    }
    return result;
  }, [entities, originOffset, rotation, angleStep, radius, halfWindow, verticalReach]);

  function snapTo(fromRotation: number, targetIndex: number) {
    const clampedIndex = Math.max(0, Math.min(entities.length - 1, targetIndex));
    const targetAbsoluteSlot = clampedIndex - originOffset;
    const targetRotation = -targetAbsoluteSlot * angleStep;
    const selectedEntity = entities[clampedIndex];
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    tweenRef.current = animateValue(
      fromRotation,
      targetRotation,
      reducedMotion ? 0 : SNAP_DURATION_MS,
      (value) => {
        liveRotationRef.current = value;
        dispatch({ type: 'ROTATE_LIVE', typeId, angle: value });
      },
      () => {
        dispatch({ type: 'ROTATE_COMMIT', typeId, selectedId: selectedEntity.id, angle: targetRotation });
      },
    );
  }

  function handlePointerDown(e: PointerEvent) {
    e.stopPropagation();
    if (!svgRef.current || entities.length === 0) return;
    tweenRef.current?.cancel();
    const local = clientToLocalPoint(svgRef.current, e.clientX, e.clientY);
    lastPointerAngleRef.current = Math.atan2(local.y, local.x);
    draggingRef.current = true;
    dispatch({ type: 'BEGIN_ROTATE', typeId, pointerAngle: lastPointerAngleRef.current });
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: PointerEvent) {
    if (!draggingRef.current || !svgRef.current) return;
    const local = clientToLocalPoint(svgRef.current, e.clientX, e.clientY);
    const currentAngle = Math.atan2(local.y, local.x);
    const incremental = angularDistance(lastPointerAngleRef.current, currentAngle);
    lastPointerAngleRef.current = currentAngle;
    const nextRotation = liveRotationRef.current + incremental;
    liveRotationRef.current = nextRotation;
    dispatch({ type: 'ROTATE_LIVE', typeId, angle: nextRotation });
  }

  function handlePointerUp() {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (entities.length === 0) {
      dispatch({ type: 'END_INTERACTION' });
      return;
    }
    const currentRotation = liveRotationRef.current;
    const targetAbsoluteSlot = Math.round(-currentRotation / angleStep);
    snapTo(currentRotation, originOffset + targetAbsoluteSlot);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (entities.length === 0) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    tweenRef.current?.cancel();
    const currentAbsoluteSlot = Math.round(-liveRotationRef.current / angleStep);
    const direction = e.key === 'ArrowRight' ? 1 : -1;
    snapTo(liveRotationRef.current, originOffset + currentAbsoluteSlot + direction);
  }

  if (entities.length === 0) {
    return (
      <text className="ring-empty-label" x={radius} y={0} textAnchor="middle">
        (sem relações)
      </text>
    );
  }

  const selectedEntity = entities.find((c) => c.id === selectedId);

  return (
    <g
      className="ring-group"
      tabIndex={0}
      role="listbox"
      aria-label={`${label}: ${selectedEntity?.label ?? ''}. Use as setas para trocar.`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
    >
      {visiblePlanets.map(({ entity, x, y, opacity }) => (
        <Planet key={entity.id} entity={entity} x={x} y={y} opacity={opacity} isSelected={entity.id === selectedId} />
      ))}
    </g>
  );
}
