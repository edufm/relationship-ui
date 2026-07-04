export type EntityTypeId = string;
export type EntityId = string;

export interface EntityType {
  id: EntityTypeId;
  label: string;
}

export interface Entity {
  id: EntityId;
  typeId: EntityTypeId;
  label: string;
}

export interface Relation {
  fromId: EntityId;
  toId: EntityId;
}

export interface Dataset {
  entityTypes: EntityType[];
  entities: Entity[];
  relations: Relation[];
}
