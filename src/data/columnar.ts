import type { Dataset, Entity, Relation } from '../model/types';

/**
 * The Orbit Explorer's single input format (v1 = CSV; v2 = Parquet with the same logical schema):
 *
 * - One row per OBJECT. The header names the orbits; column order = initial ring order
 *   (inner → outer). The object itself is always the outermost ring.
 * - Columns prefixed with `_` are object metadata, not orbits: the FIRST one names the object
 *   ring and provides each object's label (e.g. `_foto`); the rest become sidebar properties.
 * - An empty cell is an explicit "no relation" (the ring shows its "sem {tipo}" placeholder);
 *   `;` separates multiple values in one cell — never duplicate rows for multi-valued relations.
 * - Sugar: a column named `data`/`date` holding ISO dates expands into Ano → Mês → Dia orbits.
 * - Values within an orbit keep first-appearance order, so converters should emit rows sorted
 *   by the dominant hierarchy (e.g. ORDER BY date).
 *
 * Relations are co-occurrence: every attribute of a row relates to every other and to the
 * object — which is what lets rings be reordered or hidden freely.
 */

export interface ColumnarResult {
  dataset: Dataset;
  ringOrder: string[];
  warnings: string[];
}

const MAX_OBJECTS = 4000;

const DATE_COLUMN_NAMES = new Set(['data', 'date']);
/** Legacy photo-CSV headers that predate the `_` metadata convention. */
const LEGACY_OBJECT_COLUMNS = new Set(['arquivo', 'filename', 'file']);

const MONTH_NAMES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];
const MONTH_ABBREV = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** Minimal RFC-4180-ish CSV parser: quoted fields, escaped quotes, \r\n or \n. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

function prettyLabel(name: string): string {
  const words = name.replace(/^_/, '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function splitMulti(cell: string | undefined): string[] {
  if (!cell) return [];
  return cell
    .split(';')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

interface OrbitColumn {
  kind: 'orbit';
  typeId: string;
  label: string;
  columnIndex: number;
}

interface DateColumn {
  kind: 'date';
  columnIndex: number;
}

interface MetaColumn {
  kind: 'meta';
  /** Property key shown in the sidebar. */
  label: string;
  columnIndex: number;
  isObjectLabel: boolean;
}

type ColumnSpec = OrbitColumn | DateColumn | MetaColumn;

const DATE_ORBITS = [
  { typeId: 'ano', label: 'Ano' },
  { typeId: 'mes', label: 'Mês' },
  { typeId: 'dia', label: 'Dia' },
];

export function buildColumnarDataset(csvText: string, datasetName: string): ColumnarResult {
  const warnings: string[] = [];
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new Error('CSV vazio ou sem linhas de dados.');

  // --- Header → column specs + orbit ring order (object ring appended last).
  const specs: ColumnSpec[] = [];
  const orbitOrder: { typeId: string; label: string }[] = [];
  const usedTypeIds = new Set<string>();
  let objectRing: { typeId: string; label: string } | null = null;
  let hasDateColumn = false;

  rows[0].forEach((rawName, columnIndex) => {
    const name = rawName.trim();
    if (name === '') return;
    const normalized = name.toLowerCase();

    if (name.startsWith('_') || LEGACY_OBJECT_COLUMNS.has(normalized)) {
      const label = prettyLabel(name === '' ? 'item' : name.startsWith('_') ? name : 'foto');
      if (objectRing == null) {
        objectRing = { typeId: 'objeto', label };
        specs.push({ kind: 'meta', label, columnIndex, isObjectLabel: true });
      } else {
        specs.push({ kind: 'meta', label, columnIndex, isObjectLabel: false });
      }
      return;
    }

    if (DATE_COLUMN_NAMES.has(normalized)) {
      if (!hasDateColumn) {
        hasDateColumn = true;
        specs.push({ kind: 'date', columnIndex });
        for (const orbit of DATE_ORBITS) {
          orbitOrder.push(orbit);
          usedTypeIds.add(orbit.typeId);
        }
      }
      return;
    }

    let typeId = normalized;
    while (usedTypeIds.has(typeId)) typeId = `${typeId}_`;
    usedTypeIds.add(typeId);
    const orbit = { typeId, label: prettyLabel(name) };
    specs.push({ kind: 'orbit', typeId, label: orbit.label, columnIndex });
    orbitOrder.push(orbit);
  });

  const object = objectRing ?? { typeId: 'objeto', label: 'Item' };

  // --- Rows (stride-sampled so a big chronological export still covers every year).
  let dataRows = rows.slice(1);
  if (dataRows.length > MAX_OBJECTS) {
    const stride = Math.ceil(dataRows.length / MAX_OBJECTS);
    warnings.push(`CSV tem ${dataRows.length} objetos; amostrando 1 a cada ${stride} (~${Math.ceil(dataRows.length / stride)}).`);
    dataRows = dataRows.filter((_, i) => i % stride === 0);
  }

  const byType = new Map<string, Map<string, { label: string; count: number }>>();
  for (const { typeId } of orbitOrder) byType.set(typeId, new Map());
  const touch = (typeId: string, id: string, label: string) => {
    const map = byType.get(typeId)!;
    const existing = map.get(id);
    if (existing) existing.count += 1;
    else map.set(id, { label, count: 1 });
    return id;
  };

  const relationKeys = new Set<string>();
  const relations: Relation[] = [];
  const relate = (fromId: string, toId: string) => {
    const key = fromId < toId ? `${fromId} ${toId}` : `${toId} ${fromId}`;
    if (relationKeys.has(key)) return;
    relationKeys.add(key);
    relations.push({ fromId, toId });
  };

  const objectEntities: Entity[] = [];
  let invalidDates = 0;

  dataRows.forEach((row, i) => {
    const attributeIds: string[] = [];
    let objectLabel = '';
    const properties: Record<string, string | number> = {};

    for (const spec of specs) {
      const cell = (row[spec.columnIndex] ?? '').trim();
      if (spec.kind === 'meta') {
        if (spec.isObjectLabel && cell !== '') objectLabel = cell;
        else if (!spec.isObjectLabel && cell !== '') properties[spec.label] = cell;
        continue;
      }
      if (spec.kind === 'date') {
        const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(cell);
        if (match) {
          const [, year, month, day] = match;
          const monthIndex = Number(month) - 1;
          attributeIds.push(touch('ano', `ano:${year}`, year));
          attributeIds.push(touch('mes', `mes:${year}-${month}`, `${MONTH_NAMES[monthIndex] ?? month} ${year}`));
          attributeIds.push(
            touch('dia', `dia:${year}-${month}-${day}`, `${Number(day)} ${MONTH_ABBREV[monthIndex] ?? month} ${year}`),
          );
          properties['Data'] = cell;
        } else if (cell !== '') {
          invalidDates += 1;
        }
        continue;
      }
      for (const value of splitMulti(cell)) {
        attributeIds.push(touch(spec.typeId, `${spec.typeId}:${value}`, value));
      }
    }

    const objectId = `objeto:${i}`;
    const label =
      objectLabel !== ''
        ? objectLabel.length > 24
          ? `${objectLabel.slice(0, 24)}…`
          : objectLabel
        : `${object.label.toLowerCase()} ${i + 1}`;
    if (objectLabel.length > 24) properties[object.label] = objectLabel;
    objectEntities.push({
      id: objectId,
      typeId: object.typeId,
      label,
      ...(Object.keys(properties).length > 0 ? { properties } : {}),
    });

    // Co-occurrence: every attribute relates to every other and to the object itself.
    for (let a = 0; a < attributeIds.length; a++) {
      relate(attributeIds[a], objectId);
      for (let b = a + 1; b < attributeIds.length; b++) {
        if (attributeIds[a] !== attributeIds[b]) relate(attributeIds[a], attributeIds[b]);
      }
    }
  });

  if (invalidDates > 0) {
    warnings.push(`${invalidDates} objeto(s) com data fora do formato AAAA-MM-DD ficaram fora dos anéis de data.`);
  }

  const countKey = object.label.toLowerCase();
  const usedOrbits = orbitOrder.filter(({ typeId }) => byType.get(typeId)!.size > 0);
  const entities: Entity[] = [];
  for (const { typeId } of usedOrbits) {
    for (const [id, { label, count }] of byType.get(typeId)!) {
      entities.push({ id, typeId, label, properties: { [countKey]: count } });
    }
  }
  entities.push(...objectEntities);

  const entityTypes = [...usedOrbits.map(({ typeId, label }) => ({ id: typeId, label })), { id: object.typeId, label: object.label }];

  return {
    dataset: { name: datasetName, entityTypes, entities, relations },
    ringOrder: entityTypes.map((t) => t.id),
    warnings,
  };
}
