import { useEffect } from 'react';
import { useOrbit } from '../state/OrbitContext';
import type { Entity } from '../model/types';

/**
 * Detail panel for the inspected entity (opened by clicking a planet): its type, the extra
 * `properties` from the dataset, and its relations grouped by entity type. Related entities are
 * clickable to keep browsing without touching the rings.
 */
export function EntitySidebar() {
  const { state, dataset, dispatch } = useOrbit();
  const entity = state.inspected != null ? (dataset.entities.find((e) => e.id === state.inspected) ?? null) : null;

  useEffect(() => {
    if (!entity) return;
    function handleKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') dispatch({ type: 'CLOSE_INSPECT' });
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [entity, dispatch]);

  if (!entity) return null;

  const typeLabel = dataset.entityTypes.find((t) => t.id === entity.typeId)?.label ?? entity.typeId;
  const properties = Object.entries(entity.properties ?? {});

  const relatedByType = new Map<string, Entity[]>();
  for (const relation of dataset.relations) {
    const otherId =
      relation.fromId === entity.id ? relation.toId : relation.toId === entity.id ? relation.fromId : null;
    if (otherId == null) continue;
    const other = dataset.entities.find((e) => e.id === otherId);
    if (!other) continue;
    const group = relatedByType.get(other.typeId) ?? [];
    group.push(other);
    relatedByType.set(other.typeId, group);
  }
  const relatedGroups = dataset.entityTypes
    .filter((t) => relatedByType.has(t.id))
    .map((t) => ({ type: t, entities: relatedByType.get(t.id)! }));

  return (
    <aside className="entity-sidebar" aria-label={`Detalhes de ${entity.label}`}>
      <header className="entity-sidebar-header">
        <div>
          <p className="entity-sidebar-type">{typeLabel}</p>
          <h2 className="entity-sidebar-title">{entity.label}</h2>
        </div>
        <button
          className="entity-sidebar-close"
          onClick={() => dispatch({ type: 'CLOSE_INSPECT' })}
          aria-label="Fechar detalhes"
        >
          ×
        </button>
      </header>

      {properties.length > 0 && (
        <section className="entity-sidebar-section">
          <h3>Informações</h3>
          <dl className="entity-sidebar-properties">
            {properties.map(([key, value]) => (
              <div key={key} className="entity-sidebar-property">
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section className="entity-sidebar-section">
        <h3>Relacionamentos</h3>
        {relatedGroups.length === 0 && <p className="entity-sidebar-empty">Sem relacionamentos.</p>}
        {relatedGroups.map(({ type, entities }) => (
          <div key={type.id} className="entity-sidebar-relation-group">
            <h4>{type.label}</h4>
            <ul>
              {entities.map((related) => (
                <li key={related.id}>
                  <button
                    className="entity-sidebar-link"
                    onClick={() => dispatch({ type: 'INSPECT', entityId: related.id })}
                  >
                    {related.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </aside>
  );
}
