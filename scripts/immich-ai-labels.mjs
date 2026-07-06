#!/usr/bin/env node
/**
 * Exporta o CSV colunar do Orbit Explorer a partir do Immich, com uma coluna `labels` gerada
 * por IA: o Immich moderno não materializa labels (só embeddings CLIP em `smart_search`), então
 * este script pega o embedding de texto de cada conceito do vocabulário no container de machine
 * learning e classifica as fotos por similaridade de cosseno direto no banco (pgvecto-rs).
 *
 * Uso:
 *   node scripts/immich-ai-labels.mjs "postgres://immich:senha@IP:5432/immich" \
 *        "http://IP-do-ml:3003" [limiar] > fotos.csv
 *
 * - IPs dos containers: `docker inspect immich-postgres|immich-machine-learning`.
 * - `limiar` (default 0.24): similaridade mínima; suba pra menos rótulos/mais precisão.
 * - Modelo CLIP via env CLIP_MODEL (default ViT-B-32__openai — o padrão do Immich).
 * - Somente leitura no banco. Progresso vai pro stderr; o CSV, pro stdout.
 */
import pg from 'pg';

const [connectionString, mlUrl, thresholdArg] = process.argv.slice(2);
if (!connectionString || !mlUrl) {
  console.error('Uso: node scripts/immich-ai-labels.mjs <connection-string> <url-do-ml> [limiar]');
  process.exit(1);
}
const THRESHOLD = Number(thresholdArg) > 0 ? Number(thresholdArg) : 0.24;
const MODEL = process.env.CLIP_MODEL ?? 'ViT-B-32__openai';

/** Rótulo (vira valor na órbita "Labels") → prompt CLIP em inglês. */
const CONCEPTS = {
  praia: 'a photo of a beach',
  'pôr do sol': 'a photo of a sunset',
  montanha: 'a photo of mountains',
  neve: 'a photo of snow',
  cachoeira: 'a photo of a waterfall',
  floresta: 'a photo of a forest',
  lago: 'a photo of a lake',
  mar: 'a photo of the sea',
  piscina: 'a photo of a swimming pool',
  'cidade à noite': 'a photo of a city at night',
  prédios: 'a photo of buildings and architecture',
  estrada: 'a photo of a road trip',
  avião: 'a photo of an airplane',
  barco: 'a photo of a boat',
  carro: 'a photo of a car',
  comida: 'a photo of food on a table',
  bolo: 'a photo of a birthday cake',
  bebida: 'a photo of drinks',
  cachorro: 'a photo of a dog',
  gato: 'a photo of a cat',
  'animal silvestre': 'a photo of a wild animal',
  flor: 'a photo of flowers',
  bebê: 'a photo of a baby',
  criança: 'a photo of children playing',
  'grupo de pessoas': 'a group photo of many people',
  selfie: 'a selfie',
  casamento: 'a photo of a wedding',
  natal: 'a photo of christmas decorations',
  show: 'a photo of a concert',
  esporte: 'a photo of people playing sports',
  futebol: 'a photo of a football match',
  igreja: 'a photo of a church',
  museu: 'a photo of a museum or art gallery',
  documento: 'a screenshot or a photo of a document',
};

async function textEmbedding(text) {
  const form = new FormData();
  form.append('entries', JSON.stringify({ clip: { textual: { modelName: MODEL } } }));
  form.append('text', text);
  const response = await fetch(`${mlUrl.replace(/\/$/, '')}/predict`, { method: 'POST', body: form });
  if (!response.ok) throw new Error(`ML ${response.status}: ${await response.text()}`);
  const json = await response.json();
  if (!json.clip) throw new Error(`Resposta sem embedding: ${JSON.stringify(json).slice(0, 200)}`);
  return json.clip; // string "[0.1,0.2,...]" pronta pra castar ::vector
}

function csvField(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const client = new pg.Client({
  connectionString,
  statement_timeout: 60_000,
  options: '-c default_transaction_read_only=on',
});
await client.connect();

try {
  // 1) Labels por foto via similaridade de cosseno (pgvecto-rs: <=> é distância de cosseno).
  const labelsByAsset = new Map();
  for (const [label, prompt] of Object.entries(CONCEPTS)) {
    const embedding = await textEmbedding(prompt);
    const { rows } = await client.query(
      `SELECT "assetId" FROM smart_search WHERE 1 - (embedding <=> $1::vector) > $2`,
      [embedding, THRESHOLD],
    );
    for (const { assetId } of rows) {
      const set = labelsByAsset.get(assetId) ?? new Set();
      if (!labelsByAsset.has(assetId)) labelsByAsset.set(assetId, set);
      set.add(label);
    }
    console.error(`  ${label.padEnd(18)} ${rows.length} fotos`);
  }
  console.error(`${labelsByAsset.size} fotos receberam ao menos um label (limiar ${THRESHOLD}).`);

  // 2) Base por foto (mesma consulta do immich-photos.sql, com labels no lugar das tags).
  const { rows } = await client.query(`
    SELECT
      a.id,
      a."localDateTime"::date AS data,
      COALESCE(NULLIF(e.city, ''), NULLIF(e.country, ''), '') AS local,
      COALESCE(
        (SELECT string_agg(DISTINCT p.name, ';')
           FROM asset_face af JOIN person p ON p.id = af."personId"
          WHERE af."assetId" = a.id AND af."deletedAt" IS NULL AND p.name <> ''),
        '') AS pessoas,
      COALESCE(
        (SELECT string_agg(DISTINCT al."albumName", ';')
           FROM album_asset aa JOIN album al ON al.id = aa."albumId"
          WHERE aa."assetId" = a.id),
        '') AS albuns,
      a."originalFileName" AS foto
    FROM asset a
    LEFT JOIN asset_exif e ON e."assetId" = a.id
    WHERE a."deletedAt" IS NULL AND a.type = 'IMAGE'
    ORDER BY a."localDateTime"
  `);

  const lines = ['data,local,pessoas,labels,albuns,_foto'];
  for (const row of rows) {
    const labels = [...(labelsByAsset.get(row.id) ?? [])].join(';');
    lines.push(
      [row.data.toISOString().slice(0, 10), row.local, row.pessoas, labels, row.albuns, row.foto]
        .map(csvField)
        .join(','),
    );
  }
  process.stdout.write(lines.join('\n') + '\n');
  console.error(`${rows.length} fotos exportadas.`);
} finally {
  await client.end();
}
