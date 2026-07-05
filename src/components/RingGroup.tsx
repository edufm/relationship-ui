import { useLayoutEffect, useMemo, useRef, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { useOrbit } from '../state/OrbitContext';
import { buildRingDisplayList, isPlaceholderId } from '../model/selectors';
import { angleStepForRadius, angularDistance, polarToCartesian, radiusForIndex, SUN_RADIUS } from '../geometry/ring';
import { clientToLocalPoint } from '../geometry/pointer';
import { animateValue, type TweenHandle } from '../geometry/tween';
import { Planet, PLANET_RADIUS } from './Planet';

const SNAP_DURATION_MS = 180;
/** Duration of the follow-up rotation other rings make when a selection cascade re-aligns them. */
const CASCADE_DURATION_MS = 320;
/** How far beyond the visible frame we still render candidates, as a multiple of the frame's half-height — lets them fade out instead of popping out of existence right at the edge. */
const FADE_RENDER_REACH = 1.6;
/** Opacity floor for candidates near the edge of that fade zone. */
const FADE_MIN_OPACITY = 0.16;
/** Pointer travel (px) below which press+release counts as a click (opens the detail sidebar) rather than a drag. */
const CLICK_SLOP_PX = 6;

/** How many slots either side of the axis a ring of this radius must render so planets reach `renderReach` before disappearing. */
function halfWindowForRadius(radius: number, renderReach: number): number {
  const angleStep = angleStepForRadius(radius);
  return radius <= renderReach
    ? Math.max(1, Math.floor(Math.PI / angleStep))
    : Math.ceil(Math.asin(Math.min(1, renderReach / radius)) / angleStep) + 1;
}

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
 * shared reference axis. A press without drag opens the entity's detail sidebar.
 */
export function RingGroup({ typeId, index, label, viewportHalfHeight, svgRef }: RingGroupProps) {
  const { state, dataset, dispatch } = useOrbit();
  const radius = radiusForIndex(index);
  const angleStep = angleStepForRadius(radius);
  const rotation = state.rotation[typeId] ?? 0;
  const selectedId = state.selected[typeId] ?? null;

  const verticalReach = viewportHalfHeight + PLANET_RADIUS;
  const renderReach = verticalReach * FADE_RENDER_REACH;
  const halfWindow = halfWindowForRadius(radius, renderReach);

  const displayList = useMemo(
    () => buildRingDisplayList(dataset, state.ringOrder, state.selected, index, halfWindow),
    [dataset, state.ringOrder, state.selected, index, halfWindow],
  );
  const { entities, originOffset, coreLength, borrowedFrom } = displayList;

  // Live positions of the parent ring's planets, so connection lines can anchor on the actual
  // parent entity — the selected parent for core planets, the borrowed-from neighbor for
  // borrowed ones. Built with this ring's halfWindow (the same list borrowing walked over);
  // slots are measured from core[0], so positions match the parent ring's own rendering exactly.
  const parentTypeId = index > 0 ? state.ringOrder[index - 1] : null;
  const parentRotation = parentTypeId != null ? (state.rotation[parentTypeId] ?? 0) : 0;
  const parentPositions = useMemo(() => {
    if (index === 0) return null;
    const parentRadius = radiusForIndex(index - 1);
    const parentStep = angleStepForRadius(parentRadius);
    const parentList = buildRingDisplayList(dataset, state.ringOrder, state.selected, index - 1, halfWindow);
    const positions = new Map<string, { x: number; y: number }>();
    parentList.entities.forEach((entity, i) => {
      const visualSlot = i - parentList.originOffset + parentRotation / parentStep;
      positions.set(entity.id, polarToCartesian(parentRadius, visualSlot * parentStep));
    });
    return positions;
  }, [dataset, state.ringOrder, state.selected, index, halfWindow, parentRotation]);

  const lastPointerAngleRef = useRef(0);
  const liveRotationRef = useRef(rotation);
  const draggingRef = useRef(false);
  const pressRef = useRef<{ x: number; y: number; entityId: string | null; moved: boolean } | null>(null);
  const tweenRef = useRef<TweenHandle | null>(null);
  /** Last painted frame of this ring, kept so a cascade re-alignment can start its rotation from where the (re)selected entity actually was on screen. */
  const prevFrameRef = useRef<{ ids: string[]; originOffset: number; rotation: number } | null>(null);

  // liveRotationRef tracks every rotation value this component itself produced (drags, snaps,
  // cascade tweens), and this ring's own frames never change the display list. So a frame where
  // the rotation differs from it OR the list/origin changed can only be the reducer re-computing
  // this ring after a selection cascade or ring reorder. (Rotation alone isn't enough: on outer
  // rings the new alignment is often numerically identical — usually 0 — and only the list
  // shifts.) Instead of letting the ring teleport, we start it where the selected entity was
  // last painted and tween it onto the axis. Layout effect (not effect) so the correction lands
  // before the teleported frame is ever painted.
  useLayoutEffect(() => {
    const prev = prevFrameRef.current;
    prevFrameRef.current = { ids: entities.map((e) => e.id), originOffset, rotation };
    if (draggingRef.current) return;

    const listChanged =
      prev == null ||
      prev.originOffset !== originOffset ||
      prev.ids.length !== entities.length ||
      prev.ids.some((id, i) => id !== entities[i].id);
    if (rotation === liveRotationRef.current && !listChanged) return;

    let startRotation: number | null = null;
    if (prev && selectedId != null) {
      const oldIndex = prev.ids.indexOf(selectedId);
      const newIndex = entities.findIndex((e) => e.id === selectedId);
      if (oldIndex !== -1 && newIndex !== -1) {
        // Start so the selected entity keeps its on-screen position, then rotate it to slot 0.
        const oldVisualSlot = oldIndex - prev.originOffset + prev.rotation / angleStep;
        startRotation = (oldVisualSlot - (newIndex - originOffset)) * angleStep;
      }
    }
    if (startRotation == null || Math.abs(startRotation - rotation) < 1e-4) {
      // Entity wasn't previously on this ring (nothing meaningful to glide from) or it's
      // already in place — accept the reducer's value as-is.
      liveRotationRef.current = rotation;
      return;
    }

    const targetRotation = rotation;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    tweenRef.current?.cancel();
    liveRotationRef.current = startRotation;
    dispatch({ type: 'ROTATE_LIVE', typeId, angle: startRotation });
    tweenRef.current = animateValue(
      startRotation,
      targetRotation,
      reducedMotion ? 0 : CASCADE_DURATION_MS,
      (value) => {
        liveRotationRef.current = value;
        dispatch({ type: 'ROTATE_LIVE', typeId, angle: value });
      },
      () => {
        liveRotationRef.current = targetRotation;
        dispatch({ type: 'ROTATE_LIVE', typeId, angle: targetRotation });
      },
    );
  });

  const visiblePlanets = useMemo(() => {
    const result: { entity: (typeof entities)[number]; x: number; y: number; opacity: number; isCore: boolean }[] = [];
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
      const isCore = i >= originOffset && i < originOffset + coreLength;
      result.push({ entity: entities[i], x, y, opacity, isCore });
    }
    return result;
  }, [entities, originOffset, coreLength, rotation, angleStep, radius, halfWindow, verticalReach]);

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
        // Snapping onto the "sem {tipo}" placeholder commits an empty selection, not the marker.
        const selectedId = isPlaceholderId(selectedEntity.id) ? null : selectedEntity.id;
        dispatch({ type: 'ROTATE_COMMIT', typeId, selectedId, angle: targetRotation });
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
    pressRef.current = {
      x: e.clientX,
      y: e.clientY,
      entityId: (e.target as Element).closest('[data-entity-id]')?.getAttribute('data-entity-id') ?? null,
      moved: false,
    };
    dispatch({ type: 'BEGIN_ROTATE', typeId, pointerAngle: lastPointerAngleRef.current });
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: PointerEvent) {
    if (!draggingRef.current || !svgRef.current) return;
    const press = pressRef.current;
    if (press && !press.moved && Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_SLOP_PX) {
      press.moved = true;
    }
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
    const press = pressRef.current;
    pressRef.current = null;
    if (entities.length === 0) {
      dispatch({ type: 'END_INTERACTION' });
      return;
    }
    const currentRotation = liveRotationRef.current;
    const targetAbsoluteSlot = Math.round(-currentRotation / angleStep);
    snapTo(currentRotation, originOffset + targetAbsoluteSlot);
    if (press && !press.moved && press.entityId && !isPlaceholderId(press.entityId)) {
      dispatch({ type: 'INSPECT', entityId: press.entityId });
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (entities.length === 0) return;
    if (e.key === 'Enter' && selectedId) {
      e.preventDefault();
      dispatch({ type: 'INSPECT', entityId: selectedId });
      return;
    }
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

  // Connection lines anchor each planet on its true origin one ring inward: the sun for ring 0,
  // the selected parent planet for core planets, and — in a more discreet stroke — the
  // borrowed-from neighbor for borrowed planets, making it visible where they came from.
  const parentSelectedId = parentTypeId != null ? state.selected[parentTypeId] : null;

  function lineAnchor(entityId: string, isCore: boolean): { x: number; y: number; gap: number } | null {
    if (index === 0) return { x: 0, y: 0, gap: SUN_RADIUS };
    // A selection-less parent ring shows its "sem {tipo}" placeholder on the axis — chain lines
    // pass through it so the sequence stays visually continuous.
    if (isCore && parentSelectedId == null) return { x: radiusForIndex(index - 1), y: 0, gap: PLANET_RADIUS };
    const anchorId = isCore ? parentSelectedId : borrowedFrom.get(entityId);
    const position = anchorId != null ? parentPositions?.get(anchorId) : null;
    return position ? { ...position, gap: PLANET_RADIUS } : null;
  }

  return (
    <g
      className="ring-group"
      tabIndex={0}
      role="listbox"
      aria-label={`${label}: ${selectedEntity?.label ?? ''}. Use as setas para trocar, Enter para detalhes.`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
    >
      {visiblePlanets.map(({ entity, x, y, opacity, isCore }) => {
        const anchor = lineAnchor(entity.id, isCore);
        if (!anchor) return null;
        const dx = x - anchor.x;
        const dy = y - anchor.y;
        const length = Math.hypot(dx, dy);
        if (length <= anchor.gap + PLANET_RADIUS) return null;
        const ux = dx / length;
        const uy = dy / length;
        return (
          <line
            key={`connection-${entity.id}`}
            className={isCore ? 'connection-line' : 'connection-line connection-line-borrowed'}
            x1={anchor.x + ux * anchor.gap}
            y1={anchor.y + uy * anchor.gap}
            x2={x - ux * PLANET_RADIUS}
            y2={y - uy * PLANET_RADIUS}
            opacity={opacity}
          />
        );
      })}
      {visiblePlanets.map(({ entity, x, y, opacity }) => (
        <Planet
          key={entity.id}
          entity={entity}
          x={x}
          y={y}
          opacity={opacity}
          isSelected={entity.id === selectedId}
          isPlaceholder={isPlaceholderId(entity.id)}
        />
      ))}
    </g>
  );
}
