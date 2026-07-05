import type { Dataset, Entity, EntityId, EntityTypeId } from './types';

export type SelectionMap = Record<EntityTypeId, EntityId | null>;

/** Entities of `typeId` directly related (in either direction) to `sourceId`. */
export function relatedEntitiesOfType(dataset: Dataset, typeId: EntityTypeId, sourceId: EntityId): Entity[] {
  const relatedIds = new Set<EntityId>();
  for (const relation of dataset.relations) {
    if (relation.fromId === sourceId) relatedIds.add(relation.toId);
    else if (relation.toId === sourceId) relatedIds.add(relation.fromId);
  }
  return dataset.entities.filter((e) => e.typeId === typeId && relatedIds.has(e.id));
}

/**
 * Entities of ringOrder[ringIndex]'s type that are valid candidates given the
 * current selection of the ring just inside it. Ring 0 (innermost) has no
 * parent, so every entity of its type is a candidate.
 */
export function candidatesForRing(
  dataset: Dataset,
  ringOrder: EntityTypeId[],
  selected: SelectionMap,
  ringIndex: number,
): Entity[] {
  const typeId = ringOrder[ringIndex];

  if (ringIndex === 0) {
    return dataset.entities.filter((e) => e.typeId === typeId);
  }

  const parentTypeId = ringOrder[ringIndex - 1];
  const parentSelectedId = selected[parentTypeId];
  if (parentSelectedId == null) return [];

  return relatedEntitiesOfType(dataset, typeId, parentSelectedId);
}

/**
 * Recomputes selections for every ring from startIndex outward, cascading:
 * if a ring's previously selected entity is no longer a valid candidate
 * (because an inner selection or the ring order changed), it defaults to the
 * first available candidate (or null if there are none).
 */
export function recomputeFrom(
  dataset: Dataset,
  ringOrder: EntityTypeId[],
  selected: SelectionMap,
  startIndex: number,
): SelectionMap {
  const next: SelectionMap = { ...selected };

  for (let i = startIndex; i < ringOrder.length; i++) {
    const typeId = ringOrder[i];
    const candidates = candidatesForRing(dataset, ringOrder, next, i);
    const currentSelectedId = next[typeId];
    const stillValid = candidates.some((c) => c.id === currentSelectedId);
    if (!stillValid) {
      next[typeId] = candidates.length > 0 ? candidates[0].id : null;
    }
  }

  return next;
}

/**
 * When the selection committed at `ringIndex` isn't a child of the currently selected parent —
 * it came from a borrowed neighbor — walks inward re-selecting each parent (the borrowed
 * entity's own parent, then that parent's parent, and so on) until the chain is coherent again.
 * Mutates `selected` in place and returns the innermost ring index whose selection changed
 * (`ringIndex` itself when no back-propagation was needed).
 */
export function backPropagateSelection(
  dataset: Dataset,
  ringOrder: EntityTypeId[],
  selected: SelectionMap,
  ringIndex: number,
): number {
  let startIndex = ringIndex;

  for (let i = ringIndex; i > 0; i--) {
    const selectedId = selected[ringOrder[i]];
    if (selectedId == null) break;

    const candidates = candidatesForRing(dataset, ringOrder, selected, i);
    if (candidates.some((c) => c.id === selectedId)) break;

    // Among the entity's parents, prefer one that is already a valid candidate on the parent
    // ring, so back-propagation disturbs the inner selections as little as possible.
    const parents = relatedEntitiesOfType(dataset, ringOrder[i - 1], selectedId);
    if (parents.length === 0) break;
    const parentCandidates = candidatesForRing(dataset, ringOrder, selected, i - 1);
    const preferred = parents.find((p) => parentCandidates.some((c) => c.id === p.id)) ?? parents[0];

    selected[ringOrder[i - 1]] = preferred.id;
    startIndex = i - 1;
  }

  return startIndex;
}

export interface RingDisplayList {
  /** The ring's candidates plus, when there aren't enough to fill the visible window, entities
   * borrowed from the parent ring's neighboring (non-selected) entities — so scrolling past the
   * selected parent's own children continues into what the entity above/below it would show. */
  entities: Entity[];
  /** Index within `entities` of core[0] — the stable origin that absolute slots (and thus
   * rotation) are measured from. NOT the currently-selected entity's index: that would shift
   * with every new selection and break rotation's meaning as a stable, absolute encoding. */
  originOffset: number;
  /** How many entries of `entities`, starting at `originOffset`, are core candidates (children
   * of the actually-selected parent) rather than borrowed from neighbors. */
  coreLength: number;
  /** For each borrowed entity, the id of the parent-ring neighbor it was borrowed from —
   * lets the view draw a line back to its true origin. Core entities aren't in the map. */
  borrowedFrom: Map<EntityId, EntityId>;
}

/**
 * Builds the display list for one ring, extending its own candidates with entities related to
 * the parent ring's neighboring entities (above and below the parent's selection) when the
 * selected parent alone doesn't have enough children to fill `halfWindow` slots on either side.
 */
export function buildRingDisplayList(
  dataset: Dataset,
  ringOrder: EntityTypeId[],
  selected: SelectionMap,
  ringIndex: number,
  halfWindow: number,
): RingDisplayList {
  const typeId = ringOrder[ringIndex];
  const core = candidatesForRing(dataset, ringOrder, selected, ringIndex);
  const coreAnchor = Math.max(0, core.findIndex((c) => c.id === selected[typeId]));
  const borrowedFrom = new Map<EntityId, EntityId>();

  if (ringIndex === 0 || core.length === 0) {
    return { entities: core, originOffset: 0, coreLength: core.length, borrowedFrom };
  }

  const aboveDeficit = Math.max(0, halfWindow - coreAnchor);
  const belowDeficit = Math.max(0, halfWindow - (core.length - 1 - coreAnchor));

  let aboveOverflow: Entity[] = [];
  let belowOverflow: Entity[] = [];

  if (aboveDeficit > 0 || belowDeficit > 0) {
    // Borrow by walking the parent ring's *display list* (which is itself built recursively),
    // not just its core candidates — so when the parent's visible neighbors are themselves
    // borrowed, this ring can still keep filling its window from their children.
    const parentList = buildRingDisplayList(dataset, ringOrder, selected, ringIndex - 1, halfWindow);
    const parents = parentList.entities;

    // Based on the parent's committed selection, not its live (possibly mid-animation) rotation —
    // using rotation here would make the borrowed set flicker between neighbors while the parent
    // ring's own snap animation is still in flight.
    const parentK = Math.max(0, parents.findIndex((p) => p.id === selected[ringOrder[ringIndex - 1]]));

    // An entity can relate to more than one parent; never list it twice on the same ring.
    const seen = new Set(core.map((c) => c.id));

    // Walk outward toward the parent list's boundaries — never wrapping around — so "above"/
    // "below" here always matches what the parent ring itself shows above/below its selection.
    const collect = (direction: -1 | 1, deficit: number): Entity[] => {
      const chunks: Entity[][] = [];
      let count = 0;
      for (let i = parentK + direction; count < deficit && i >= 0 && i < parents.length; i += direction) {
        const chunk = relatedEntitiesOfType(dataset, typeId, parents[i].id).filter((e) => !seen.has(e.id));
        for (const entity of chunk) {
          seen.add(entity.id);
          borrowedFrom.set(entity.id, parents[i].id);
        }
        chunks.push(chunk);
        count += chunk.length;
      }
      // Above: nearest neighbor (parentK-1) contributes last, so its children end up adjacent to core.
      return direction === -1 ? chunks.reverse().flat() : chunks.flat();
    };

    if (aboveDeficit > 0) aboveOverflow = collect(-1, aboveDeficit);
    if (belowDeficit > 0) belowOverflow = collect(1, belowDeficit);
  }

  return {
    entities: [...aboveOverflow, ...core, ...belowOverflow],
    originOffset: aboveOverflow.length,
    coreLength: core.length,
    borrowedFrom,
  };
}
