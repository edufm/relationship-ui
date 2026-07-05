import type { Dataset, Entity, EntityId, EntityTypeId } from './types';

export type SelectionMap = Record<EntityTypeId, EntityId | null>;

/** Lazily-built adjacency index for a dataset, so selection math doesn't rescan every relation. */
interface DatasetIndex {
  /** Entities of each type, preserving dataset order (which drives ring ordering). */
  entitiesByType: Map<EntityTypeId, Entity[]>;
  neighborsByEntity: Map<EntityId, Set<EntityId>>;
  /** Unordered type pairs for which at least one relation exists — tells whether filtering one type by another is meaningful at all. */
  relatedTypePairs: Set<string>;
}

const indexCache = new WeakMap<Dataset, DatasetIndex>();

function typePairKey(a: EntityTypeId, b: EntityTypeId): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function getDatasetIndex(dataset: Dataset): DatasetIndex {
  const cached = indexCache.get(dataset);
  if (cached) return cached;

  const entitiesByType = new Map<EntityTypeId, Entity[]>();
  const typeByEntity = new Map<EntityId, EntityTypeId>();
  for (const entity of dataset.entities) {
    const list = entitiesByType.get(entity.typeId);
    if (list) list.push(entity);
    else entitiesByType.set(entity.typeId, [entity]);
    typeByEntity.set(entity.id, entity.typeId);
  }

  const neighborsByEntity = new Map<EntityId, Set<EntityId>>();
  const relatedTypePairs = new Set<string>();
  const addNeighbor = (a: EntityId, b: EntityId) => {
    const set = neighborsByEntity.get(a);
    if (set) set.add(b);
    else neighborsByEntity.set(a, new Set([b]));
  };
  for (const relation of dataset.relations) {
    addNeighbor(relation.fromId, relation.toId);
    addNeighbor(relation.toId, relation.fromId);
    const fromType = typeByEntity.get(relation.fromId);
    const toType = typeByEntity.get(relation.toId);
    if (fromType != null && toType != null) relatedTypePairs.add(typePairKey(fromType, toType));
  }

  const index = { entitiesByType, neighborsByEntity, relatedTypePairs };
  indexCache.set(dataset, index);
  return index;
}

/** Entities of `typeId` directly related (in either direction) to `sourceId`. */
export function relatedEntitiesOfType(dataset: Dataset, typeId: EntityTypeId, sourceId: EntityId): Entity[] {
  const { entitiesByType, neighborsByEntity } = getDatasetIndex(dataset);
  const neighbors = neighborsByEntity.get(sourceId);
  if (!neighbors) return [];
  return (entitiesByType.get(typeId) ?? []).filter((e) => neighbors.has(e.id));
}

/**
 * Entities of ringOrder[ringIndex]'s type that are valid candidates given the
 * current selection of the ring just inside it. Ring 0 (innermost) has no
 * parent, so every entity of its type is a candidate.
 *
 * Rings whose type has nothing related to the current chain select null; they are skipped —
 * the anchor is the nearest inner ring that HAS a selection. Otherwise one data-less link
 * (e.g. photos without location) would blank every ring outside it, even when relations to the
 * inner rings exist (co-occurrence datasets relate every attribute pair directly).
 *
 * Filtering is cumulative: after anchoring, candidates are further intersected with every other
 * selected inner ring whose type is related to this one at all. In a co-occurrence dataset that
 * makes the photo ring show only photos matching the whole selected chain (year AND day AND
 * place AND person); in FK-chain datasets unrelated type pairs are skipped, so per-neighbor
 * behavior is preserved.
 */
export function candidatesForRing(
  dataset: Dataset,
  ringOrder: EntityTypeId[],
  selected: SelectionMap,
  ringIndex: number,
): Entity[] {
  const typeId = ringOrder[ringIndex];
  const { entitiesByType, neighborsByEntity, relatedTypePairs } = getDatasetIndex(dataset);

  if (ringIndex === 0) {
    return entitiesByType.get(typeId) ?? [];
  }

  let anchorIndex = -1;
  for (let i = ringIndex - 1; i >= 0; i--) {
    if (selected[ringOrder[i]] != null) {
      anchorIndex = i;
      break;
    }
  }
  if (anchorIndex === -1) return [];

  let candidates = relatedEntitiesOfType(dataset, typeId, selected[ringOrder[anchorIndex]]!);

  for (let i = anchorIndex - 1; i >= 0 && candidates.length > 0; i--) {
    const innerId = selected[ringOrder[i]];
    if (innerId == null || !relatedTypePairs.has(typePairKey(typeId, ringOrder[i]))) continue;
    const innerNeighbors = neighborsByEntity.get(innerId);
    candidates = candidates.filter((c) => innerNeighbors?.has(c.id));
  }

  return candidates;
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
 * When the selection committed at `ringIndex` isn't a valid candidate for the current chain —
 * it came from a borrowed neighbor, or an inner selection conflicts with it under cumulative
 * filtering — rebuilds the inner chain anchored on the committed entity: every inner ring whose
 * type relates to the committed one re-selects a candidate compatible with it (kept unchanged
 * when already compatible), inner-to-outer so each step sees the reconciled rings before it.
 * Mutates `selected` in place and returns the innermost ring index whose selection changed
 * (`ringIndex` itself when nothing needed to change).
 */
export function backPropagateSelection(
  dataset: Dataset,
  ringOrder: EntityTypeId[],
  selected: SelectionMap,
  ringIndex: number,
): number {
  const committedId = selected[ringOrder[ringIndex]];
  if (committedId == null) return ringIndex;
  if (candidatesForRing(dataset, ringOrder, selected, ringIndex).some((c) => c.id === committedId)) {
    return ringIndex;
  }

  const { neighborsByEntity, relatedTypePairs } = getDatasetIndex(dataset);
  const committedNeighbors = neighborsByEntity.get(committedId) ?? new Set<EntityId>();
  const committedType = ringOrder[ringIndex];
  let innermostChanged = ringIndex;

  for (let i = 0; i < ringIndex; i++) {
    const typeId = ringOrder[i];
    const candidates = candidatesForRing(dataset, ringOrder, selected, i);
    const compatible = relatedTypePairs.has(typePairKey(typeId, committedType))
      ? candidates.filter((c) => committedNeighbors.has(c.id))
      : candidates;
    // A ring with candidates but none compatible keeps its normal pool: better an incoherent
    // link (which the cascade will surface) than blanking a ring the entity says nothing about.
    const pool = compatible.length > 0 ? compatible : candidates;

    const currentId = selected[typeId];
    if (currentId != null && pool.some((c) => c.id === currentId)) continue;
    selected[typeId] = pool.length > 0 ? pool[0].id : null;
    innermostChanged = Math.min(innermostChanged, i);
  }

  return innermostChanged;
}

/** Id prefix of the synthetic "sem {tipo}" planet shown when a ring has no candidate for the
 * current chain. Display-only: it is never a valid selection and never reaches the sidebar. */
export const PLACEHOLDER_PREFIX = '__none__:';

export function isPlaceholderId(id: EntityId): boolean {
  return id.startsWith(PLACEHOLDER_PREFIX);
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
  const candidates = candidatesForRing(dataset, ringOrder, selected, ringIndex);
  const borrowedFrom = new Map<EntityId, EntityId>();

  if (ringIndex === 0) {
    return { entities: candidates, originOffset: 0, coreLength: candidates.length, borrowedFrom };
  }

  // No candidate for the current chain → a synthetic "sem {tipo}" placeholder holds the axis
  // slot, so borrowed neighbors settle around it instead of one of them sitting ambiguously on
  // the axis as if it belonged to the chain.
  const core: Entity[] =
    candidates.length > 0
      ? candidates
      : [
          {
            id: PLACEHOLDER_PREFIX + typeId,
            typeId,
            label: `sem ${(dataset.entityTypes.find((t) => t.id === typeId)?.label ?? typeId).toLowerCase()}`,
          },
        ];
  const coreAnchor = Math.max(0, core.findIndex((c) => c.id === selected[typeId]));

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
