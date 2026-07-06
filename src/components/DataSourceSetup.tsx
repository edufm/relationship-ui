import { useEffect, useState, type ChangeEvent } from 'react';
import type { Dataset } from '../model/types';
import { buildColumnarDataset } from '../data/columnar';
import sampleMonumentsCsv from '../data/sample-monuments.csv?raw';
import samplePhotosCsv from '../data/sample-photos.csv?raw';

export interface DataSource {
  dataset: Dataset;
  ringOrder: string[];
}

interface TableInfo {
  schema: string;
  name: string;
  approxRows: number;
}

interface ErdEdge {
  kind: 'direct' | 'join';
  from: string;
  to: string;
  column?: string;
  via?: string;
}

interface ErdInfo {
  edges: ErdEdge[];
  islands: string[];
  skippedComposite: number;
}

interface ColumnarCsvResponse {
  name: string;
  csv: string;
  stats: Record<string, number>;
  warnings: string[];
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/pg/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(json.error ?? `HTTP ${response.status}`);
  return json;
}

const tableKey = (t: TableInfo) => `${t.schema}.${t.name}`;

/**
 * Landing screen for picking the data source. Everything funnels into the single columnar
 * format (see src/data/columnar.ts): bundled sample CSVs, an uploaded CSV, or a live Postgres
 * database — which acts as a built-in converter emitting that same CSV (downloadable).
 */
export function DataSourceSetup({ onLoaded }: { onLoaded: (source: DataSource) => void }) {
  const [connectionString, setConnectionString] = useState('');
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [erd, setErd] = useState<ErdInfo | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState<'connect' | 'explore' | 'download' | null>(null);
  const [error, setError] = useState<string | null>(null);

  function loadCsv(text: string, name: string) {
    setError(null);
    setWarnings([]);
    try {
      const result = buildColumnarDataset(text, name);
      // The setup screen unmounts right away, so surface warnings on the console too.
      if (result.warnings.length > 0) console.warn('orbit/columnar:', result.warnings);
      onLoaded({ dataset: result.dataset, ringOrder: result.ringOrder });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function handleCsvFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    file
      .text()
      .then((text) => loadCsv(text, file.name.replace(/\.csv$/i, '')))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    event.target.value = '';
  }

  async function connect() {
    setBusy('connect');
    setError(null);
    setTables(null);
    setSelected(new Set());
    setErd(null);
    try {
      const { tables } = await post<{ tables: TableInfo[] }>('tables', { connectionString });
      setTables(tables);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // Refresh the FK summary whenever the selection changes (stale responses are discarded).
  useEffect(() => {
    if (selected.size < 2) {
      setErd(null);
      return;
    }
    let stale = false;
    post<ErdInfo>('erd', { connectionString, tables: [...selected] })
      .then((result) => {
        if (!stale) setErd(result);
      })
      .catch(() => {
        if (!stale) setErd(null);
      });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  async function fetchColumnarCsv(): Promise<ColumnarCsvResponse> {
    const result = await post<ColumnarCsvResponse>('dataset', { connectionString, tables: [...selected] });
    if (result.warnings.length > 0) setWarnings(result.warnings);
    return result;
  }

  async function explore() {
    setBusy('explore');
    setError(null);
    setWarnings([]);
    try {
      const result = await fetchColumnarCsv();
      loadCsv(result.csv, result.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function downloadCsv() {
    setBusy('download');
    setError(null);
    try {
      const result = await fetchColumnarCsv();
      const url = URL.createObjectURL(new Blob([result.csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${result.name}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="source-setup">
      <div className="source-card">
        <h1 className="source-title">Orbit Explorer</h1>
        <p className="source-subtitle">
          Tudo entra pelo mesmo formato: um CSV onde cada coluna é uma órbita e cada linha um objeto
        </p>

        <p className="source-hint source-hint-tight">
          Cabeçalho nomeia as órbitas (ordem = ordem dos anéis); colunas <code>_prefixadas</code> são metadados do
          objeto (a primeira dá nome e rótulo ao anel de objetos); célula vazia = sem relação; multi-valores com{' '}
          <code>;</code>; coluna <code>data</code> ISO vira Ano → Mês → Dia. Detalhes no README.
        </p>

        <div className="source-connect">
          <label className="source-button source-file">
            Carregar CSV…
            <input type="file" accept=".csv,text/csv" onChange={handleCsvFile} hidden />
          </label>
          <button className="source-button" onClick={() => loadCsv(sampleMonumentsCsv, 'Monumentos')}>
            Exemplo: monumentos
          </button>
          <button className="source-button" onClick={() => loadCsv(samplePhotosCsv, 'Fotos (exemplo)')}>
            Exemplo: fotos
          </button>
        </div>

        <div className="source-divider">ou converta um Postgres para o formato</div>

        <div className="source-connect">
          <input
            className="source-input"
            type="text"
            value={connectionString}
            placeholder="postgres://usuario:senha@host:5432/banco"
            onChange={(e) => setConnectionString(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && connectionString && connect()}
          />
          <button className="source-button" disabled={!connectionString || busy != null} onClick={connect}>
            {busy === 'connect' ? 'Conectando…' : 'Conectar'}
          </button>
        </div>

        {error && <p className="source-error">{error}</p>}
        {warnings.map((w) => (
          <p key={w} className="source-warning">
            {w}
          </p>
        ))}

        {tables && (
          <>
            <p className="source-hint">
              {tables.length} tabelas — marque as de interesse (a conexão é somente leitura; a mais externa vira o
              objeto):
            </p>
            <ul className="source-tables">
              {tables.map((t) => {
                const key = tableKey(t);
                return (
                  <li key={key}>
                    <label className={selected.has(key) ? 'selected' : ''}>
                      <input type="checkbox" checked={selected.has(key)} onChange={() => toggle(key)} />
                      <span className="source-table-name">{key}</span>
                      <span className="source-table-rows">~{t.approxRows.toLocaleString('pt-BR')}</span>
                    </label>
                  </li>
                );
              })}
            </ul>

            {erd && (
              <div className="source-erd">
                {erd.edges.length === 0 && <p className="source-warning">Nenhuma foreign key liga as tabelas marcadas.</p>}
                {erd.edges.map((e, i) => (
                  <p key={i} className="source-erd-edge">
                    {e.from} → {e.to} {e.kind === 'join' ? `(via ${e.via})` : `(${e.column})`}
                  </p>
                ))}
                {erd.islands.length > 0 && (
                  <p className="source-warning">Sem conexão com as demais: {erd.islands.join(', ')}</p>
                )}
              </div>
            )}

            <div className="source-connect source-actions">
              <button
                className="source-button source-explore"
                disabled={selected.size === 0 || busy != null}
                onClick={explore}
              >
                {busy === 'explore' ? 'Montando órbitas…' : `Explorar ${selected.size} tabela(s)`}
              </button>
              <button className="source-button" disabled={selected.size === 0 || busy != null} onClick={downloadCsv}>
                {busy === 'download' ? 'Gerando…' : 'Baixar CSV'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
