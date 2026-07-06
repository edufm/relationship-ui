# Orbit Explorer

## Objetivo

Explorar dados relacionais (tabelas, bancos, ontologias) com hierarquia/relações entre entidades de um jeito mais intuitivo que o grafo "flat" clássico. A metáfora é um sistema solar: o dataset é o sol no centro, cada tipo de entidade é uma órbita (anel concêntrico), cada instância é um "planeta" nessa órbita. Um retângulo (a tela) funciona como janela sobre essas órbitas — não mostramos o círculo inteiro, só a fatia que cabe na janela, e o resto some/aparece conforme você gira.

Interação central: arrastar um anel gira todos os seus planetas juntos até que um deles alinhe no eixo de referência (a linha horizontal que atravessa todos os anéis) — esse é o selecionado. Selecionar um planeta atualiza em cascata os anéis mais externos, mostrando só as entidades relacionadas. O nome de cada órbita fica sobre o eixo de referência, logo antes do planeta selecionado, e arrastá-lo radialmente troca a posição do anel com o vizinho, mudando a hierarquia de navegação. Clicar num planeta abre a barra lateral de detalhes.

## Como rodar

```bash
npm install
npm run dev
```

## O formato de entrada (o contrato da UI)

A UI aceita **um único formato**, colunar e objeto-cêntrico — cada coluna é uma órbita, cada linha um objeto; o objeto é encontrado quando todos os planetas alinham. Codificação v1: **CSV** (RFC-4180, UTF-8, com cabeçalho). Parquet está planejado como codificação v2 do mesmo schema lógico (LIST nativo pra multi-valores).

- **Uma linha por objeto.** O cabeçalho nomeia as órbitas; a **ordem das colunas é a ordem inicial dos anéis** (interno → externo). O objeto é sempre o anel mais externo.
- **Colunas prefixadas com `_` são metadados do objeto**, não órbitas: a **primeira** `_coluna` dá o nome do anel de objetos e o rótulo de cada objeto (ex.: `_foto`, `_livro`); as demais aparecem como informações na barra lateral (ex.: `_páginas`, `_nota`).
- **Célula vazia = sem relação**, explícito — vira o placeholder "sem {órbita}". **`;` separa multi-valores** na mesma célula (uma foto `sunset;beach` é uma linha só; nunca duplique linhas).
- **Açúcar de data**: uma coluna `data`/`date` com valores ISO (`AAAA-MM-DD…`) expande automaticamente em órbitas Ano → Mês → Dia.
- **Ordem dos valores numa órbita = primeira aparição no arquivo** — conversores devem emitir linhas ordenadas pela hierarquia dominante (ex.: `ORDER BY` data).
- As relações são por coocorrência (todo atributo da linha se relaciona com os demais e com o objeto), o que permite reordenar/ocultar anéis livremente; entidades agregadas mostram a contagem de objetos na barra lateral.

Exemplo mínimo:

```csv
data,gênero,autores,_livro,_páginas
2001-04-10,Fantasia,Tolkien;Christopher Tolkien,Silmarillion Anotado,400
2005-08-02,,Asimov,Fundação,320
```

O loader é `src/data/columnar.ts` (CSVs grandes são amostrados uniformemente, ~4.000 objetos; cabeçalho legado `arquivo` é aceito como `_foto`).

## Fontes na tela inicial (todas viram o formato acima)

- **Carregar CSV** ou usar as amostras embutidas: `src/data/sample-monuments.csv` (Continente → País → Cidade → Monumento) e `src/data/sample-photos.csv`.
- **Exportar do Immich**: query pronta em `scripts/immich-photos.sql`:
  ```bash
  docker exec -i immich-postgres psql -U immich -d immich -f - < scripts/immich-photos.sql > fotos.csv
  ```
- **Conversor Postgres embutido**: informe a connection string, marque as tabelas de interesse e o servidor (`server/pgApi.ts`, middleware do Vite) lê o ERD (foreign keys) e **emite o CSV padrão** — a tabela mais externa da cadeia FK vira o objeto (uma linha por linha dela) e cada outra tabela vira uma coluna com os rótulos das linhas relacionadas, seguindo caminhos de FK inclusive através de tabelas intermediárias e junções colapsadas (`;` quando várias, vazio quando nenhuma). Botão **"Baixar CSV"** entrega o mesmo arquivo pra reuso. Segurança: conexão somente leitura, identificadores escapados, colunas sensíveis (senha/token/segredo) e tipos não-escalares nunca saem do servidor. Relações que não passam pelo objeto (ex.: `album→user` quando o objeto é `asset`) se achatam pela linha do objeto.

## O que já foi construído

- **Modelo de dados genérico** (`src/model/types.ts`): grafo tipado (EntityType, Entity, Relation) sem assumir hierarquia fixa em árvore — a hierarquia sai da ordem dos anéis escolhida + arestas existentes. O dataset tem `name` (vira o sol) e entidades podem ter `properties` livres.
- **Girar pra selecionar** com filtragem em cascata (`src/components/RingGroup.tsx`, `src/state/orbitState.ts`): arrastar/teclado (setas ←→) rotaciona um anel; ao soltar, o candidato mais próximo do eixo é selecionado e os anéis mais externos recalculam. Selecionar uma entidade **emprestada** de um vizinho propaga a mudança pra trás: os anéis internos re-selecionam os ancestrais reais dela e a cascata recomeça dali (`backPropagateSelection` em `src/model/selectors.ts`).
- **Reordenar anéis** arrastando o rótulo do tipo — que fica sobre o eixo de referência, logo antes do planeta selecionado do anel — radialmente (ou a trilha vazia, quando visível) (`src/components/RingTrack.tsx`): o anel vai pra posição onde foi solto, **atravessando quantos níveis for** (os anéis no caminho deslizam uma posição), mudando qual tipo de entidade é "pai" de qual.
- **Janela retangular + scroll infinito** (`src/model/selectors.ts::buildRingDisplayList`, geometria em `src/geometry/ring.ts`): os anéis não mostram o círculo inteiro, só uma fatia estreita; o espaçamento entre planetas é fixo (não esticado pra preencher 360°), então poucos itens não ficam vazios e muitos não ficam espremidos. Suporta múltiplas voltas sem travar.
- **Preenchimento por vizinhança recursivo**: quando a entidade selecionada não tem filhos suficientes pra preencher a janela, o anel seguinte pega emprestado das entidades vizinhas (acima/abaixo) do anel pai — e o empréstimo agora é recursivo (usa o display list do pai, não só os candidatos dele), então continua funcionando até a última camada mesmo quando os vizinhos do pai também são emprestados.
- **Sol central**: o nome do dataset fica no centro, sem órbita própria, como o sol da analogia.
- **Linhas de conexão**: linhas sutis ligam o selecionado de um anel (e o sol, no primeiro anel) aos seus relacionados no anel seguinte. Entidades emprestadas ganham uma linha mais discreta (cinza, tracejada) ligando ao vizinho de origem no anel de dentro — deixando claro de onde vieram. As âncoras seguem a posição real do planeta pai, inclusive durante a rotação.
- **Ocultar órbitas**: um × discreto no rótulo de cada anel (aparece no hover) o esconde; chips no canto inferior esquerdo o trazem de volta pra posição onde estava. A navegação pula anéis ocultos usando as relações com o anel selecionado mais interno (útil sobretudo em datasets de coocorrência, como o modo CSV). O último anel visível não pode ser ocultado.
- **Filtragem cumulativa**: os candidatos de um anel são a interseção com **todas** as seleções internas cujo tipo tenha relação com ele — no modo CSV, o anel de fotos mostra só fotos que casam com a cadeia inteira (ano ∧ dia ∧ local ∧ pessoa). Pares de tipos sem nenhuma relação são pulados, então datasets em cadeia FK mantêm o comportamento por vizinho. Interseção vazia deixa o anel sem seleção: um planeta tracejado "sem {tipo}" segura o slot do eixo (as linhas da cadeia passam por ele) e os vizinhos emprestados assentam ao redor. Selecionar um emprestado reconstrói a cadeia interna inteira ancorada nele, mantendo as seleções atuais quando compatíveis. O dataset ganhou um índice de adjacência (`getDatasetIndex` em `selectors.ts`) pra isso não varrer as ~50k relações a cada consulta.
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
- **Linhas de conexão através de anéis sem seleção**: quando o anel imediatamente interno está vazio/sem seleção, os planetas core não desenham linha (a âncora seria o anel pulado, mais pra dentro).
