import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import pg from 'pg';

/**
 * Vite dev-server middleware that lets the frontend explore a Postgres database:
 *   POST /api/pg/tables   {connectionString}                    → tables + approx row counts
 *   POST /api/pg/erd      {connectionString, tables[]}          → FK edges among chosen tables
 *   POST /api/pg/dataset  {connectionString, tables[], rowLimit} → Orbit Explorer Dataset
 *
 * Read-only by construction: every connection opens with default_transaction_read_only=on and a
 * statement timeout, only SELECTs are issued, and identifiers are always escaped.
 */

const STATEMENT_TIMEOUT_MS = 10_000;
const DEFAULT_ROOT_LIMIT = 40;
const PER_TABLE_CAP = 250;
const VALUE_CHUNK = 400;
const MAX_PROPERTY_COLUMNS = 8;
const MAX_TEXT_LENGTH = 200;

const TEXT_TYPES = new Set(['text', 'character varying', 'character', 'citext']);
const SCALAR_TYPES = new Set([
  ...TEXT_TYPES,
  'uuid',
  'integer',
  'bigint',
  'smallint',
  'numeric',
  'real',
  'double precision',
  'boolean',
  'date',
  'timestamp without time zone',
  'timestamp with time zone',
  'time without time zone',
]);
/** Columns that must never reach the client as label or property, whatever their type. */
const SENSITIVE_COLUMN = /password|secret|token|salt|credential|api_?key|private/i;

const LABEL_CANDIDATES = [
  'name',
  'title',
  'label',
  'username',
  'email',
  'originalfilename',
  'original_file_name',
  'filename',
];
/** Only when nothing name-ish exists — often empty or long. */
const WEAK_LABEL_CANDIDATES = ['description', 'slug'];

interface ColumnInfo {
  name: string;
  dataType: string;
}

interface ForeignKey {
  fromSchema: string;
  fromTable: string;
  fromColumns: string[];
  toSchema: string;
  toTable: string;
  toColumns: string[];
}

/** `schema.table`, the key used everywhere tables are referenced across requests. */
function tableKey(schema: string, table: string): string {
  return `${schema}.${table}`;
}

async function withClient<T>(connectionString: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 8_000,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: STATEMENT_TIMEOUT_MS,
    options: '-c default_transaction_read_only=on',
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function listTables(client: pg.Client) {
  const { rows } = await client.query(`
    SELECT n.nspname AS schema, c.relname AS name, GREATEST(c.reltuples, 0)::bigint AS approx_rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY n.nspname, c.relname
  `);
  return rows.map((r) => ({ schema: r.schema as string, name: r.name as string, approxRows: Number(r.approx_rows) }));
}

async function listForeignKeys(client: pg.Client): Promise<ForeignKey[]> {
  const { rows } = await client.query(`
    SELECT
      src_ns.nspname AS from_schema, src.relname AS from_table,
      tgt_ns.nspname AS to_schema, tgt.relname AS to_table,
      (SELECT array_agg(att.attname ORDER BY u.ord)
         FROM unnest(con.conkey) WITH ORDINALITY u(attnum, ord)
         JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.attnum)::text[] AS from_columns,
      (SELECT array_agg(att.attname ORDER BY u.ord)
         FROM unnest(con.confkey) WITH ORDINALITY u(attnum, ord)
         JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = u.attnum)::text[] AS to_columns
    FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
    JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
    JOIN pg_class tgt ON tgt.oid = con.confrelid
    JOIN pg_namespace tgt_ns ON tgt_ns.oid = tgt.relnamespace
    WHERE con.contype = 'f'
  `);
  return rows.map((r) => ({
    fromSchema: r.from_schema,
    fromTable: r.from_table,
    fromColumns: r.from_columns,
    toSchema: r.to_schema,
    toTable: r.to_table,
    toColumns: r.to_columns,
  }));
}

async function listColumns(client: pg.Client, schema: string, table: string): Promise<ColumnInfo[]> {
  const { rows } = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
    [schema, table],
  );
  return rows.map((r) => ({ name: r.column_name as string, dataType: r.data_type as string }));
}

async function listPrimaryKeys(client: pg.Client): Promise<Map<string, string[]>> {
  const { rows } = await client.query(`
    SELECT ns.nspname AS schema, cl.relname AS table,
      (SELECT array_agg(att.attname ORDER BY u.ord)
         FROM unnest(con.conkey) WITH ORDINALITY u(attnum, ord)
         JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.attnum)::text[] AS columns
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace
    WHERE con.contype = 'p'
  `);
  const map = new Map<string, string[]>();
  for (const r of rows) map.set(tableKey(r.schema, r.table), r.columns);
  return map;
}

/** Direct FK edge between two selected tables (single-column FKs only). */
interface DirectEdge {
  kind: 'direct';
  childKey: string;
  parentKey: string;
  /** FK column on the child table. */
  fkColumn: string;
  /** Referenced column on the parent (usually its PK). */
  refColumn: string;
}

/** Two selected tables bridged by an unselected pure join table (e.g. albums_assets_assets). */
interface JoinEdge {
  kind: 'join';
  viaSchema: string;
  viaTable: string;
  aKey: string;
  aFkColumn: string;
  aRefColumn: string;
  bKey: string;
  bFkColumn: string;
  bRefColumn: string;
}

type Edge = DirectEdge | JoinEdge;

/** Computes direct + collapsed-join edges among `selected` from the database's full FK list. */
function buildEdges(fks: ForeignKey[], selected: Set<string>): { edges: Edge[]; skippedComposite: number } {
  const edges: Edge[] = [];
  let skippedComposite = 0;

  const byOwner = new Map<string, ForeignKey[]>();
  for (const fk of fks) {
    const fromKey = tableKey(fk.fromSchema, fk.fromTable);
    const toKey = tableKey(fk.toSchema, fk.toTable);
    if (fk.fromColumns.length !== 1) {
      if (selected.has(fromKey) && selected.has(toKey)) skippedComposite += 1;
      continue;
    }
    if (selected.has(fromKey) && selected.has(toKey) && fromKey !== toKey) {
      edges.push({
        kind: 'direct',
        childKey: fromKey,
        parentKey: toKey,
        fkColumn: fk.fromColumns[0],
        refColumn: fk.toColumns[0],
      });
    } else if (!selected.has(fromKey) && selected.has(toKey)) {
      const list = byOwner.get(fromKey) ?? [];
      list.push(fk);
      byOwner.set(fromKey, list);
    }
  }

  // A non-selected table with FKs to ≥2 distinct selected tables acts as a join table: collapse
  // every pair of its selected targets into an implicit edge.
  for (const ownerFks of byOwner.values()) {
    for (let i = 0; i < ownerFks.length; i++) {
      for (let j = i + 1; j < ownerFks.length; j++) {
        const a = ownerFks[i];
        const b = ownerFks[j];
        const aKey = tableKey(a.toSchema, a.toTable);
        const bKey = tableKey(b.toSchema, b.toTable);
        if (aKey === bKey) continue;
        edges.push({
          kind: 'join',
          viaSchema: a.fromSchema,
          viaTable: a.fromTable,
          aKey,
          aFkColumn: a.fromColumns[0],
          aRefColumn: a.toColumns[0],
          bKey,
          bFkColumn: b.fromColumns[0],
          bRefColumn: b.toColumns[0],
        });
      }
    }
  }

  return { edges, skippedComposite };
}

/**
 * Ring order that keeps adjacent rings actually connected: starts from the topological root and
 * greedily extends with a neighbor of the last placed table (lowest FK-degree first, so hub
 * tables stay in the middle of the chain where both sides can filter through them). Rings that
 * end up next to a non-neighbor would show "(sem relações)" — the user can still drag to fix.
 */
function chainOrder(selected: string[], edges: Edge[]): string[] {
  if (selected.length === 0) return [];
  const neighbors = new Map<string, Set<string>>(selected.map((k) => [k, new Set<string>()]));
  for (const edge of edges) {
    const [a, b] = edge.kind === 'direct' ? [edge.childKey, edge.parentKey] : [edge.aKey, edge.bKey];
    if (a !== b && neighbors.has(a) && neighbors.has(b)) {
      neighbors.get(a)!.add(b);
      neighbors.get(b)!.add(a);
    }
  }
  const topo = topologicalOrder(selected, edges);
  const degree = (k: string) => neighbors.get(k)!.size;
  const byPreference = (candidates: string[]) =>
    candidates.slice().sort((a, b) => degree(a) - degree(b) || topo.indexOf(a) - topo.indexOf(b))[0];

  const placed = [topo[0]];
  const used = new Set(placed);
  while (placed.length < selected.length) {
    const last = placed[placed.length - 1];
    const ofLast = topo.filter((k) => !used.has(k) && neighbors.get(last)!.has(k));
    const ofAny = topo.filter((k) => !used.has(k) && placed.some((p) => neighbors.get(p)!.has(k)));
    const rest = topo.filter((k) => !used.has(k));
    const pick = ofLast.length > 0 ? byPreference(ofLast) : ofAny.length > 0 ? byPreference(ofAny) : rest[0];
    placed.push(pick);
    used.add(pick);
  }
  return placed;
}

/** Parents (FK targets) come first — they become the inner rings. Cycles broken by least pending deps. */
function topologicalOrder(selected: string[], edges: Edge[]): string[] {
  const pendingParents = new Map<string, Set<string>>(selected.map((k) => [k, new Set<string>()]));
  for (const edge of edges) {
    if (edge.kind === 'direct') pendingParents.get(edge.childKey)?.add(edge.parentKey);
  }
  const order: string[] = [];
  const placed = new Set<string>();
  while (order.length < selected.length) {
    let best: string | null = null;
    let bestPending = Infinity;
    for (const key of selected) {
      if (placed.has(key)) continue;
      const pending = [...(pendingParents.get(key) ?? [])].filter((p) => !placed.has(p)).length;
      if (pending < bestPending) {
        best = key;
        bestPending = pending;
      }
    }
    if (best == null) break;
    order.push(best);
    placed.add(best);
  }
  return order;
}

function sanitizeValue(value: unknown): string | number | null {
  if (value == null) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return typeof value === 'boolean' ? String(value) : value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || typeof value === 'object') return null;
  const text = String(value);
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}…` : text;
}

interface TablePlan {
  key: string;
  schema: string;
  table: string;
  pkColumns: string[];
  labelColumn: string | null;
  propertyColumns: string[];
  /** Every column the row query selects (pk + fks + label + properties). */
  selectColumns: string[];
}

function planTable(key: string, allColumns: ColumnInfo[], pkColumns: string[], edges: Edge[]): TablePlan {
  const [schema, table] = key.split('.');
  const byName = new Map(allColumns.map((c) => [c.name, c]));
  const columns = allColumns.filter((c) => !SENSITIVE_COLUMN.test(c.name));

  const fkColumns = new Set<string>();
  for (const edge of edges) {
    if (edge.kind === 'direct' && edge.childKey === key) fkColumns.add(edge.fkColumn);
    if (edge.kind === 'direct' && edge.parentKey === key) fkColumns.add(edge.refColumn);
    if (edge.kind === 'join' && edge.aKey === key) fkColumns.add(edge.aRefColumn);
    if (edge.kind === 'join' && edge.bKey === key) fkColumns.add(edge.bRefColumn);
  }

  const textish = (c: ColumnInfo) => TEXT_TYPES.has(c.dataType);
  const labelColumn =
    columns.find((c) => textish(c) && LABEL_CANDIDATES.includes(c.name.toLowerCase()))?.name ??
    columns.find((c) => textish(c) && /name|title|label/i.test(c.name))?.name ??
    columns.find((c) => textish(c) && WEAK_LABEL_CANDIDATES.includes(c.name.toLowerCase()))?.name ??
    columns.find((c) => textish(c) && !pkColumns.includes(c.name) && !fkColumns.has(c.name))?.name ??
    null;

  const propertyColumns = columns
    .filter((c) => SCALAR_TYPES.has(c.dataType) && !pkColumns.includes(c.name) && !fkColumns.has(c.name))
    .slice(0, MAX_PROPERTY_COLUMNS)
    .map((c) => c.name);

  const selectColumns = [...new Set([...pkColumns, ...fkColumns, ...(labelColumn ? [labelColumn] : []), ...propertyColumns])].filter(
    (name) => byName.has(name),
  );

  return { key, schema, table, pkColumns, labelColumn, propertyColumns, selectColumns };
}

function chunk<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

type Row = Record<string, unknown>;

/** Rows fetched for one table, keyed by pk-as-text, plus per-column text indexes for FK lookups. */
class TableRows {
  rows = new Map<string, Row>();
  readonly plan: TablePlan;

  constructor(plan: TablePlan) {
    this.plan = plan;
  }

  pkText(row: Row): string {
    return this.plan.pkColumns.map((c) => String(row[c])).join('|');
  }

  add(row: Row): void {
    const pk = this.pkText(row);
    if (!this.rows.has(pk)) this.rows.set(pk, row);
  }

  columnValues(column: string): string[] {
    const out = new Set<string>();
    for (const row of this.rows.values()) {
      const v = row[column];
      if (v != null) out.add(String(v));
    }
    return [...out];
  }

  /** Maps a column's text value → entity pk text (for resolving FK references). */
  indexBy(column: string): Map<string, string> {
    const index = new Map<string, string>();
    for (const [pk, row] of this.rows) {
      const v = row[column];
      if (v != null) index.set(String(v), pk);
    }
    return index;
  }
}

function selectList(client: pg.Client, plan: TablePlan): string {
  return plan.selectColumns.map((c) => client.escapeIdentifier(c)).join(', ');
}

function qualified(client: pg.Client, schema: string, table: string): string {
  return `${client.escapeIdentifier(schema)}.${client.escapeIdentifier(table)}`;
}

async function fetchRootRows(client: pg.Client, plan: TablePlan, limit: number): Promise<Row[]> {
  const orderBy = plan.pkColumns.map((c) => client.escapeIdentifier(c)).join(', ');
  const { rows } = await client.query(
    `SELECT ${selectList(client, plan)} FROM ${qualified(client, plan.schema, plan.table)} ORDER BY ${orderBy} LIMIT $1`,
    [limit],
  );
  return rows;
}

async function fetchRowsWhereIn(
  client: pg.Client,
  plan: TablePlan,
  whereColumn: string,
  values: string[],
  cap: number,
): Promise<Row[]> {
  const out: Row[] = [];
  for (const part of chunk(values, VALUE_CHUNK)) {
    if (out.length >= cap) break;
    const { rows } = await client.query(
      `SELECT ${selectList(client, plan)} FROM ${qualified(client, plan.schema, plan.table)}
       WHERE ${client.escapeIdentifier(whereColumn)}::text = ANY($1::text[]) LIMIT $2`,
      [part, cap - out.length],
    );
    out.push(...rows);
  }
  return out;
}

async function fetchJoinPairs(client: pg.Client, edge: JoinEdge, aValues: string[]): Promise<[string, string][]> {
  const pairs: [string, string][] = [];
  const aCol = client.escapeIdentifier(edge.aFkColumn);
  const bCol = client.escapeIdentifier(edge.bFkColumn);
  for (const part of chunk(aValues, VALUE_CHUNK)) {
    const { rows } = await client.query(
      `SELECT ${aCol} AS a, ${bCol} AS b FROM ${qualified(client, edge.viaSchema, edge.viaTable)}
       WHERE ${aCol}::text = ANY($1::text[]) AND ${bCol} IS NOT NULL`,
      [part],
    );
    for (const r of rows) pairs.push([String(r.a), String(r.b)]);
  }
  return pairs;
}

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Builds the Orbit columnar CSV (the app's single input format) from the selected tables:
 * one row per row of the OUTERMOST table of the FK chain (the "object"); every other selected
 * table becomes an orbit column whose cell holds the labels of the rows related to the object —
 * following FK paths across intermediate tables, `;`-joined when there are many, empty when
 * none. The object's own scalar columns become `_`-prefixed metadata columns.
 */
async function buildColumnarCsv(client: pg.Client, selectedKeys: string[], rootLimit: number) {
  const fks = await listForeignKeys(client);
  const pks = await listPrimaryKeys(client);
  const selected = new Set(selectedKeys);
  const { edges } = buildEdges(fks, selected);
  const warnings: string[] = [];

  const plans = new Map<string, TablePlan>();
  for (const key of selectedKeys) {
    const [schema, table] = key.split('.');
    const pkColumns = pks.get(key);
    if (!pkColumns) {
      warnings.push(`Tabela ${key} não tem chave primária — ignorada.`);
      continue;
    }
    const columns = await listColumns(client, schema, table);
    plans.set(key, planTable(key, columns, pkColumns, edges));
  }

  const usableKeys = selectedKeys.filter((k) => plans.has(k));
  const usableEdges = edges.filter((e) =>
    e.kind === 'direct' ? plans.has(e.childKey) && plans.has(e.parentKey) : plans.has(e.aKey) && plans.has(e.bKey),
  );
  const order = chainOrder(usableKeys, usableEdges);

  const tableRows = new Map<string, TableRows>(usableKeys.map((k) => [k, new TableRows(plans.get(k)!)]));
  const joinPairs = new Map<JoinEdge, [string, string][]>();

  // BFS over the ERD from the innermost table, always fetching only rows related to what was
  // already collected — a blind per-table LIMIT would produce disconnected orbits.
  if (order.length > 0) {
    const root = tableRows.get(order[0])!;
    for (const row of await fetchRootRows(client, root.plan, rootLimit)) root.add(row);

    const visited = new Set<string>([order[0]]);
    const queue = [order[0]];
    while (queue.length > 0) {
      const currentKey = queue.shift()!;
      const current = tableRows.get(currentKey)!;

      for (const edge of usableEdges) {
        let nextKey: string | null = null;
        if (edge.kind === 'direct') {
          if (edge.childKey === currentKey && !visited.has(edge.parentKey)) {
            nextKey = edge.parentKey;
            const values = current.columnValues(edge.fkColumn);
            const next = tableRows.get(nextKey)!;
            for (const row of await fetchRowsWhereIn(client, next.plan, edge.refColumn, values, PER_TABLE_CAP)) next.add(row);
          } else if (edge.parentKey === currentKey && !visited.has(edge.childKey)) {
            nextKey = edge.childKey;
            const values = current.columnValues(edge.refColumn);
            const next = tableRows.get(nextKey)!;
            for (const row of await fetchRowsWhereIn(client, next.plan, edge.fkColumn, values, PER_TABLE_CAP)) next.add(row);
          }
        } else {
          const forward = edge.aKey === currentKey && !visited.has(edge.bKey);
          const backward = edge.bKey === currentKey && !visited.has(edge.aKey);
          if (forward || backward) {
            // Walk the join table from the side we already have rows for, to discover the other.
            const fromRef = forward ? edge.aRefColumn : edge.bRefColumn;
            const fromFk = forward ? edge.aFkColumn : edge.bFkColumn;
            const toFk = forward ? edge.bFkColumn : edge.aFkColumn;
            const toRef = forward ? edge.bRefColumn : edge.aRefColumn;
            nextKey = forward ? edge.bKey : edge.aKey;

            const values = current.columnValues(fromRef);
            const rawPairs = await fetchJoinPairs(client, { ...edge, aFkColumn: fromFk, bFkColumn: toFk }, values);
            // Cache normalized to (aValue, bValue) so the relations phase doesn't refetch.
            joinPairs.set(edge, forward ? rawPairs : rawPairs.map(([x, y]) => [y, x] as [string, string]));

            const next = tableRows.get(nextKey)!;
            const targetValues = [...new Set(rawPairs.map(([, to]) => to))];
            for (const row of await fetchRowsWhereIn(client, next.plan, toRef, targetValues, PER_TABLE_CAP)) next.add(row);
          }
        }
        if (nextKey != null) {
          visited.add(nextKey);
          queue.push(nextKey);
        }
      }
    }

    for (const key of usableKeys) {
      if (!visited.has(key)) warnings.push(`Tabela ${key} não tem caminho de FKs até ${order[0]} — ficará vazia.`);
    }
  }

  // Row-level hop maps between adjacent tables (both directions), used to walk FK paths from
  // each object row to every orbit table — including across intermediate tables.
  const hops = new Map<string, Map<string, Set<string>>>();
  const addHop = (fromKey: string, fromPk: string, toKey: string, toPk: string) => {
    for (const [k, a, b] of [
      [`${fromKey}>${toKey}`, fromPk, toPk],
      [`${toKey}>${fromKey}`, toPk, fromPk],
    ] as const) {
      const map = hops.get(k) ?? new Map<string, Set<string>>();
      if (!hops.has(k)) hops.set(k, map);
      const set = map.get(a) ?? new Set<string>();
      if (!map.has(a)) map.set(a, set);
      set.add(b);
    }
  };

  const tableNeighbors = new Map<string, Set<string>>(usableKeys.map((k) => [k, new Set<string>()]));
  for (const edge of usableEdges) {
    const [ka, kb] = edge.kind === 'direct' ? [edge.childKey, edge.parentKey] : [edge.aKey, edge.bKey];
    tableNeighbors.get(ka)?.add(kb);
    tableNeighbors.get(kb)?.add(ka);
    if (edge.kind === 'direct') {
      const child = tableRows.get(edge.childKey)!;
      const parentIndex = tableRows.get(edge.parentKey)!.indexBy(edge.refColumn);
      for (const [childPk, row] of child.rows) {
        const fkValue = row[edge.fkColumn];
        if (fkValue == null) continue;
        const parentPk = parentIndex.get(String(fkValue));
        if (parentPk != null) addHop(edge.childKey, childPk, edge.parentKey, parentPk);
      }
    } else {
      const a = tableRows.get(edge.aKey)!;
      const b = tableRows.get(edge.bKey)!;
      let pairs = joinPairs.get(edge);
      if (!pairs) pairs = await fetchJoinPairs(client, edge, a.columnValues(edge.aRefColumn));
      const aIndex = a.indexBy(edge.aRefColumn);
      const bIndex = b.indexBy(edge.bRefColumn);
      for (const [aValue, bValue] of pairs) {
        const aPk = aIndex.get(aValue);
        const bPk = bIndex.get(bValue);
        if (aPk != null && bPk != null) addHop(edge.aKey, aPk, edge.bKey, bPk);
      }
    }
  }

  /** Shortest table-level path between two tables over the FK graph (BFS), or null. */
  const tablePath = (fromKey: string, toKey: string): string[] | null => {
    const previous = new Map<string, string>([[fromKey, fromKey]]);
    const queue = [fromKey];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === toKey) {
        const path = [toKey];
        while (path[0] !== fromKey) path.unshift(previous.get(path[0])!);
        return path;
      }
      for (const next of tableNeighbors.get(current) ?? []) {
        if (!previous.has(next)) {
          previous.set(next, current);
          queue.push(next);
        }
      }
    }
    return null;
  };

  const rowLabel = (tableKey: string, pk: string): string => {
    const table = tableRows.get(tableKey)!;
    const row = table.rows.get(pk);
    const raw = row && table.plan.labelColumn ? sanitizeValue(row[table.plan.labelColumn]) : null;
    const label = raw != null && String(raw).trim() !== '' ? String(raw) : `${tableKey.split('.')[1]} ${pk.slice(0, 8)}`;
    // ";" is the format's list separator — it can't appear inside a value.
    return label.replace(/;/g, ',');
  };

  const objectKey = order[order.length - 1];
  const objectTable = tableRows.get(objectKey)!;
  const objectName = objectKey.split('.')[1];
  const orbitKeys = order.slice(0, -1);
  const orbitPaths = new Map<string, string[] | null>(orbitKeys.map((k) => [k, tablePath(objectKey, k)]));
  for (const [key, path] of orbitPaths) {
    if (path == null) warnings.push(`Tabela ${key} não tem caminho de FKs até ${objectKey} — coluna ficará vazia.`);
  }

  const header = [
    ...orbitKeys.map((k) => k.split('.')[1]),
    `_${objectName}`,
    ...objectTable.plan.propertyColumns.map((c) => `_${c}`),
  ];
  const lines = [header.map(csvField).join(',')];

  for (const [pk, row] of objectTable.rows) {
    const cells: string[] = [];
    for (const key of orbitKeys) {
      const path = orbitPaths.get(key);
      if (!path) {
        cells.push('');
        continue;
      }
      let current = new Set([pk]);
      for (let i = 0; i + 1 < path.length; i++) {
        const hop = hops.get(`${path[i]}>${path[i + 1]}`);
        const next = new Set<string>();
        for (const p of current) for (const q of hop?.get(p) ?? []) next.add(q);
        current = next;
        if (current.size === 0) break;
      }
      cells.push([...current].map((targetPk) => rowLabel(key, targetPk)).join(';'));
    }
    cells.push(rowLabel(objectKey, pk));
    for (const col of objectTable.plan.propertyColumns) {
      const v = sanitizeValue(row[col]);
      cells.push(v == null ? '' : String(v));
    }
    lines.push(cells.map(csvField).join(','));
  }

  if (objectTable.rows.size === 0) warnings.push(`A tabela-objeto ${objectKey} não retornou linhas.`);

  return {
    name: client.database ?? 'postgres',
    csv: lines.join('\n'),
    stats: Object.fromEntries(order.map((key) => [key, tableRows.get(key)!.rows.size])),
    warnings,
  };
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (part: Buffer) => {
      size += part.length;
      if (size > 1_000_000) reject(new Error('Body too large'));
      else chunks.push(part);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

export function orbitPgPlugin(): Plugin {
  return {
    name: 'orbit-pg-api',
    configureServer(server) {
      server.middlewares.use('/api/pg', (req, res) => {
        void (async () => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' });
          const body = await readBody(req);
          const connectionString = String(body.connectionString ?? '');
          if (!connectionString) return sendJson(res, 400, { error: 'connectionString é obrigatória' });

          if (req.url === '/tables') {
            const tables = await withClient(connectionString, listTables);
            return sendJson(res, 200, { tables });
          }

          const tables = Array.isArray(body.tables) ? body.tables.map(String) : [];
          if (tables.length === 0) return sendJson(res, 400, { error: 'Selecione ao menos uma tabela' });

          if (req.url === '/erd') {
            const result = await withClient(connectionString, async (client) => {
              const fks = await listForeignKeys(client);
              const selected = new Set(tables);
              const { edges, skippedComposite } = buildEdges(fks, selected);
              const connected = new Set<string>();
              for (const e of edges) {
                if (e.kind === 'direct') {
                  connected.add(e.childKey);
                  connected.add(e.parentKey);
                } else {
                  connected.add(e.aKey);
                  connected.add(e.bKey);
                }
              }
              return {
                edges: edges.map((e) =>
                  e.kind === 'direct'
                    ? { kind: 'direct', from: e.childKey, to: e.parentKey, column: e.fkColumn }
                    : { kind: 'join', from: e.aKey, to: e.bKey, via: `${e.viaSchema}.${e.viaTable}` },
                ),
                islands: tables.filter((t) => !connected.has(t)),
                skippedComposite,
              };
            });
            return sendJson(res, 200, result);
          }

          if (req.url === '/dataset') {
            const rowLimit = Number(body.rowLimit) > 0 ? Math.min(Number(body.rowLimit), 500) : DEFAULT_ROOT_LIMIT;
            const result = await withClient(connectionString, (client) => buildColumnarCsv(client, tables, rowLimit));
            return sendJson(res, 200, result);
          }

          return sendJson(res, 404, { error: `Rota desconhecida: ${req.url}` });
        })().catch((error: unknown) => {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        });
      });
    },
  };
}
