import type { Dataset } from '../model/types';
import raw from './monuments.json';

function validate(dataset: Dataset): Dataset {
  const typeIds = new Set(dataset.entityTypes.map((t) => t.id));
  const entityIds = new Set(dataset.entities.map((e) => e.id));

  for (const entity of dataset.entities) {
    if (!typeIds.has(entity.typeId)) {
      throw new Error(`Entity "${entity.id}" references unknown typeId "${entity.typeId}"`);
    }
  }
  for (const relation of dataset.relations) {
    if (!entityIds.has(relation.fromId)) {
      throw new Error(`Relation references unknown fromId "${relation.fromId}"`);
    }
    if (!entityIds.has(relation.toId)) {
      throw new Error(`Relation references unknown toId "${relation.toId}"`);
    }
  }
  return dataset;
}

export const dataset: Dataset = validate(raw as Dataset);
