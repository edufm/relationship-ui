import type { Dataset, Entity, EntityId, EntityTypeId } from '../model/types';
import { backPropagateSelection, candidatesForRing, recomputeFrom, type SelectionMap } from '../model/selectors';
import { angleStepForRadius, radiusForIndex } from '../geometry/ring';

export type Interaction =
  | { kind: 'idle' }
  | { kind: 'rotating'; typeId: EntityTypeId; pointerStartAngle: number; rotationStart: number }
  | { kind: 'reordering'; typeId: EntityTypeId; pointerStartRadius: number };

export interface OrbitState {
  ringOrder: EntityTypeId[];
  rotation: Record<EntityTypeId, number>;
  selected: SelectionMap;
  interaction: Interaction;
  /** Entity whose detail sidebar is open, if any. Independent of ring selection. */
  inspected: EntityId | null;
}

export type OrbitAction =
  | { type: 'BEGIN_ROTATE'; typeId: EntityTypeId; pointerAngle: number }
  | { type: 'ROTATE_LIVE'; typeId: EntityTypeId; angle: number }
  | { type: 'ROTATE_COMMIT'; typeId: EntityTypeId; selectedId: EntityId | null; angle: number }
  | { type: 'BEGIN_REORDER'; typeId: EntityTypeId; pointerRadius: number }
  | { type: 'REORDER_COMMIT'; fromIndex: number; toIndex: number }
  | { type: 'END_INTERACTION' }
  | { type: 'INSPECT'; entityId: EntityId }
  | { type: 'CLOSE_INSPECT' };

/** Rotation a ring needs so that `selectedId` (if present among `candidates`) lands exactly on the reference axis (angle 0), using the ring's fixed slot spacing. */
function computeAlignedRotation(candidates: Entity[], selectedId: EntityId | null, radius: number): number {
  if (selectedId == null) return 0;
  const index = candidates.findIndex((c) => c.id === selectedId);
  if (index === -1) return 0;
  return -index * angleStepForRadius(radius);
}

export function createInitialOrbitState(dataset: Dataset, ringOrder: EntityTypeId[]): OrbitState {
  const emptySelected: SelectionMap = {};
  for (const typeId of ringOrder) emptySelected[typeId] = null;
  const selected = recomputeFrom(dataset, ringOrder, emptySelected, 0);

  const rotation: Record<EntityTypeId, number> = {};
  ringOrder.forEach((typeId, i) => {
    const candidates = candidatesForRing(dataset, ringOrder, selected, i);
    rotation[typeId] = computeAlignedRotation(candidates, selected[typeId], radiusForIndex(i));
  });

  return { ringOrder, rotation, selected, interaction: { kind: 'idle' }, inspected: null };
}

/** Recomputes selection + aligned rotation for every ring from `startIndex` outward. Used after a selection change or a ring reorder. */
function cascade(
  dataset: Dataset,
  ringOrder: EntityTypeId[],
  selected: SelectionMap,
  rotation: Record<EntityTypeId, number>,
  startIndex: number,
): { selected: SelectionMap; rotation: Record<EntityTypeId, number> } {
  const nextSelected = recomputeFrom(dataset, ringOrder, selected, startIndex);
  const nextRotation = { ...rotation };
  for (let i = startIndex; i < ringOrder.length; i++) {
    const typeId = ringOrder[i];
    const candidates = candidatesForRing(dataset, ringOrder, nextSelected, i);
    nextRotation[typeId] = computeAlignedRotation(candidates, nextSelected[typeId], radiusForIndex(i));
  }
  return { selected: nextSelected, rotation: nextRotation };
}

export function createOrbitReducer(dataset: Dataset) {
  return function orbitReducer(state: OrbitState, action: OrbitAction): OrbitState {
    switch (action.type) {
      case 'BEGIN_ROTATE': {
        const rotationStart = state.rotation[action.typeId] ?? 0;
        return {
          ...state,
          interaction: {
            kind: 'rotating',
            typeId: action.typeId,
            pointerStartAngle: action.pointerAngle,
            rotationStart,
          },
        };
      }

      case 'ROTATE_LIVE': {
        return {
          ...state,
          rotation: { ...state.rotation, [action.typeId]: action.angle },
        };
      }

      case 'ROTATE_COMMIT': {
        const index = state.ringOrder.indexOf(action.typeId);
        const committedSelected: SelectionMap = { ...state.selected, [action.typeId]: action.selectedId };
        const committedRotation = { ...state.rotation, [action.typeId]: action.angle };
        // If the committed entity was borrowed from a neighbor, re-select its real ancestors on
        // the inner rings first; then the cascade must restart from the innermost changed ring
        // (realigning this ring too), instead of only from the rings outside it.
        const innermostChanged = backPropagateSelection(dataset, state.ringOrder, committedSelected, index);
        const { selected, rotation } = cascade(
          dataset,
          state.ringOrder,
          committedSelected,
          committedRotation,
          innermostChanged === index ? index + 1 : innermostChanged,
        );
        return { ...state, selected, rotation, interaction: { kind: 'idle' } };
      }

      case 'BEGIN_REORDER': {
        return {
          ...state,
          interaction: { kind: 'reordering', typeId: action.typeId, pointerStartRadius: action.pointerRadius },
        };
      }

      case 'REORDER_COMMIT': {
        const { fromIndex, toIndex } = action;
        if (fromIndex === toIndex) return { ...state, interaction: { kind: 'idle' } };
        const newRingOrder = [...state.ringOrder];
        [newRingOrder[fromIndex], newRingOrder[toIndex]] = [newRingOrder[toIndex], newRingOrder[fromIndex]];
        const startIndex = Math.min(fromIndex, toIndex);
        const { selected, rotation } = cascade(dataset, newRingOrder, state.selected, state.rotation, startIndex);
        return { ...state, ringOrder: newRingOrder, selected, rotation, interaction: { kind: 'idle' } };
      }

      case 'END_INTERACTION':
        return { ...state, interaction: { kind: 'idle' } };

      case 'INSPECT':
        return { ...state, inspected: action.entityId };

      case 'CLOSE_INSPECT':
        return { ...state, inspected: null };

      default:
        return state;
    }
  };
}
