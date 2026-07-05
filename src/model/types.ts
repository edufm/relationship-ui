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
  /** Extra key→value facts shown in the detail sidebar; not used for navigation. */
  properties?: Record<string, string | number>;
}

export interface Relation {
  fromId: EntityId;
  toId: EntityId;
}

export interface Dataset {
  /** Display name of the dataset — rendered as the central "sun". */
  name: string;
  entityTypes: EntityType[];
  entities: Entity[];
  relations: Relation[];
}
