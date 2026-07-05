-- Exporta um CSV de fotos do Immich no formato que o Orbit Explorer lê no modo "CSV de fotos":
--   data, local, pessoas, tags, albuns, arquivo   (multivalores separados por ";")
--
-- Uso (ajuste usuário/banco/container se necessário):
--   docker exec -i immich-postgres psql -U immich -d immich -f - < scripts/immich-photos.sql > fotos.csv
--
-- Somente leitura. Schema alvo: Immich recente (tabelas no singular: asset, album, album_asset,
-- asset_exif, asset_face, person, tag, tag_asset). Em versões antigas os nomes eram no plural
-- (assets, exif, albums_assets_assets…) — adapte os nomes se o psql reclamar.

COPY (
  SELECT
    a."localDateTime"::date AS data,
    COALESCE(NULLIF(e.city, ''), NULLIF(e.country, ''), '') AS local,
    COALESCE(
      (SELECT string_agg(DISTINCT p.name, ';')
         FROM asset_face af
         JOIN person p ON p.id = af."personId"
        WHERE af."assetId" = a.id AND af."deletedAt" IS NULL AND p.name <> ''),
      '') AS pessoas,
    COALESCE(
      (SELECT string_agg(DISTINCT t.value, ';')
         FROM tag_asset ta
         JOIN tag t ON t.id = ta."tagId"
        WHERE ta."assetId" = a.id),
      '') AS tags,
    COALESCE(
      (SELECT string_agg(DISTINCT al."albumName", ';')
         FROM album_asset aa
         JOIN album al ON al.id = aa."albumId"
        WHERE aa."assetId" = a.id),
      '') AS albuns,
    a."originalFileName" AS arquivo
  FROM asset a
  LEFT JOIN asset_exif e ON e."assetId" = a.id
  WHERE a."deletedAt" IS NULL AND a.type = 'IMAGE'
  ORDER BY a."localDateTime"
) TO STDOUT WITH (FORMAT csv, HEADER);
