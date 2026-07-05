# Orbit Explorer

## Objetivo

Explorar dados relacionais (tabelas, bancos, ontologias) com hierarquia/relações entre entidades de um jeito mais intuitivo que o grafo "flat" clássico. A metáfora é um sistema solar: o dataset é o sol no centro, cada tipo de entidade é uma órbita (anel concêntrico), cada instância é um "planeta" nessa órbita. Um retângulo (a tela) funciona como janela sobre essas órbitas — não mostramos o círculo inteiro, só a fatia que cabe na janela, e o resto some/aparece conforme você gira.

Interação central: arrastar um anel gira todos os seus planetas juntos até que um deles alinhe no eixo de referência (a linha horizontal que atravessa todos os anéis) — esse é o selecionado. Selecionar um planeta atualiza em cascata os anéis mais externos, mostrando só as entidades relacionadas. O nome de cada órbita fica sobre o eixo de referência, logo antes do planeta selecionado, e arrastá-lo radialmente troca a posição do anel com o vizinho, mudando a hierarquia de navegação. Clicar num planeta abre a barra lateral de detalhes.

## Como rodar

```bash
npm install
npm run dev
```

## Fontes de dados

A tela inicial oferece três fontes:

- **Dataset de exemplo** (`src/data/monuments.json`): Continente → País → Cidade → Monumento, recriando o rascunho original. Entidades podem ter `properties` (chave→valor) exibidas na barra lateral.
- **CSV de fotos** (ex.: exportado do Immich): uma linha por foto com colunas `data, local, pessoas, tags, albuns, arquivo` (multivalores separados por `;`). O loader (`src/data/photoCsv.ts`) agrega em órbitas **Ano → Mês → Dia → Localização → Pessoa → Tag → Álbum → Foto**, com relações por coocorrência (todo atributo de uma foto se relaciona com os demais), então os anéis podem ser arrastados pra **qualquer** ordem — ex.: Pessoa → Ano mostra em que anos aquela pessoa aparece. Cada entidade agregada traz a contagem de fotos nas `properties`. CSVs grandes são amostrados uniformemente (~4.000 fotos) pra cobrir todos os anos. Query pronta pro Immich em `scripts/immich-photos.sql`:
  ```bash
  docker exec -i immich-postgres psql -U immich -d immich -f - < scripts/immich-photos.sql > fotos.csv
  ```
- **Postgres ao vivo**: informe a connection string, marque as tabelas de interesse e o app lê o ERD (foreign keys) pra montar o dataset — tabela=tipo/órbita, linha=planeta, FK=relação, colunas=`properties`. O backend é um middleware do próprio Vite (`server/pgApi.ts`, endpoints `/api/pg/*`): conexão **somente leitura** (`default_transaction_read_only`), identificadores escapados, colunas sensíveis (senha/token/segredo) nunca saem do servidor, tipos não-escalares (bytea, vector) são ignorados. Tabelas de junção não selecionadas (ex.: `album_asset`) são colapsadas em relações diretas; a busca de linhas caminha o grafo FK a partir da tabela mais interna (BFS, ~250 linhas/tabela) pra trazer um subgrafo conexo em vez de fatias soltas; e a ordem inicial dos anéis é uma cadeia que mantém anéis vizinhos conectados por FK (hubs no meio).

## O que já foi construído

- **Modelo de dados genérico** (`src/model/types.ts`): grafo tipado (EntityType, Entity, Relation) sem assumir hierarquia fixa em árvore — a hierarquia sai da ordem dos anéis escolhida + arestas existentes. O dataset tem `name` (vira o sol) e entidades podem ter `properties` livres.
- **Girar pra selecionar** com filtragem em cascata (`src/components/RingGroup.tsx`, `src/state/orbitState.ts`): arrastar/teclado (setas ←→) rotaciona um anel; ao soltar, o candidato mais próximo do eixo é selecionado e os anéis mais externos recalculam. Selecionar uma entidade **emprestada** de um vizinho propaga a mudança pra trás: os anéis internos re-selecionam os ancestrais reais dela e a cascata recomeça dali (`backPropagateSelection` em `src/model/selectors.ts`).
- **Reordenar anéis** arrastando o rótulo do tipo — que fica sobre o eixo de referência, logo antes do planeta selecionado do anel — radialmente (ou a trilha vazia, quando visível) (`src/components/RingTrack.tsx`): o anel vai pra posição onde foi solto, **atravessando quantos níveis for** (os anéis no caminho deslizam uma posição), mudando qual tipo de entidade é "pai" de qual.
- **Janela retangular + scroll infinito** (`src/model/selectors.ts::buildRingDisplayList`, geometria em `src/geometry/ring.ts`): os anéis não mostram o círculo inteiro, só uma fatia estreita; o espaçamento entre planetas é fixo (não esticado pra preencher 360°), então poucos itens não ficam vazios e muitos não ficam espremidos. Suporta múltiplas voltas sem travar.
- **Preenchimento por vizinhança recursivo**: quando a entidade selecionada não tem filhos suficientes pra preencher a janela, o anel seguinte pega emprestado das entidades vizinhas (acima/abaixo) do anel pai — e o empréstimo agora é recursivo (usa o display list do pai, não só os candidatos dele), então continua funcionando até a última camada mesmo quando os vizinhos do pai também são emprestados.
- **Sol central**: o nome do dataset fica no centro, sem órbita própria, como o sol da analogia.
- **Linhas de conexão**: linhas sutis ligam o selecionado de um anel (e o sol, no primeiro anel) aos seus relacionados no anel seguinte. Entidades emprestadas ganham uma linha mais discreta (cinza, tracejada) ligando ao vizinho de origem no anel de dentro — deixando claro de onde vieram. As âncoras seguem a posição real do planeta pai, inclusive durante a rotação.
- **Barra lateral de detalhes** (`src/components/EntitySidebar.tsx`): clique (sem arrasto) num planeta, ou Enter com o anel focado, abre um painel com tipo, `properties` e relacionamentos agrupados por tipo (navegáveis por clique). Esc ou × fecha.
- **Cascata animada**: quando uma seleção muda, os outros anéis não teleportam pro novo alinhamento — cada anel afetado começa com a entidade re-selecionada na posição em que ela estava na tela e gira até encaixá-la no eixo (`RingGroup`, tween de ~320ms com ease-out; respeita `prefers-reduced-motion`). Interrompível: arrastar ou usar o teclado no meio da animação cancela o tween daquele anel.
- **Esmaecimento gradual**: planetas longe do eixo central vão ficando mais transparentes em vez de sumir de repente, até um corte suave nas bordas da janela.
- **Visual**: tema "astrolábio/orrery" — céu índigo profundo, anéis gravados finos, seleção em latão com brilho, rótulos serifados. Acessibilidade básica (foco por teclado, `prefers-reduced-motion`).

## Limitações conhecidas

- **Reordenar pra uma hierarquia sem arestas diretas** (ex: colocar Cidade logo depois de Continente) mostra "(sem relações)" nos anéis externos — o modelo só segue relações diretas entre camadas vizinhas. Faz sentido pro modelo atual, mas talvez valha atravessar relações transitivas no futuro.
- **Fatos do dataset de exemplo** (`properties` de países/monumentos) são aproximados, só pra demonstrar a barra lateral.

## Planejado

- **Ontologias (fase 2)**: ler Turtle/SKOS (ex.: [Athena](https://github.com/artemis-tech/Athena)). Exige uma decisão de modelagem — as hierarquias SKOS são árvores profundas dentro de um mesmo tipo (`skos:broader`), então anel = nível de profundidade em vez de anel = tipo — e fatiar os ~527k triplas antes de chegar ao browser.
- **Clique também seleciona**: hoje o clique só abre a barra lateral; talvez girar o anel até o planeta clicado ao mesmo tempo.
- **Filtragem cumulativa opcional**: a cascata filtra cada anel só pelo vizinho de dentro; num modo "interseção", o anel de fotos mostraria apenas fotos que casam com a cadeia inteira selecionada.
