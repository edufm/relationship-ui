# Orbit Explorer

## Objetivo

Explorar dados relacionais (tabelas, bancos, ontologias) com hierarquia/relações entre entidades de um jeito mais intuitivo que o grafo "flat" clássico. A metáfora é um sistema solar: o dataset é o sol no centro, cada tipo de entidade é uma órbita (anel concêntrico), cada instância é um "planeta" nessa órbita. Um retângulo (a tela) funciona como janela sobre essas órbitas — não mostramos o círculo inteiro, só a fatia que cabe na janela, e o resto some/aparece conforme você gira.

Interação central: arrastar um anel gira todos os seus planetas juntos até que um deles alinhe no eixo de referência (a linha horizontal que atravessa todos os anéis) — esse é o selecionado. Selecionar um planeta atualiza em cascata os anéis mais externos, mostrando só as entidades relacionadas. O nome de cada órbita fica sobre o eixo de referência, logo antes do planeta selecionado, e arrastá-lo radialmente troca a posição do anel com o vizinho, mudando a hierarquia de navegação. Clicar num planeta abre a barra lateral de detalhes.

## Como rodar

```bash
npm install
npm run dev
```

Dataset de exemplo em `src/data/monuments.json` (Continente → País → Cidade → Monumento, com o nome do dataset como sol), recriando o rascunho original do projeto. Entidades podem ter um campo `properties` (chave→valor) exibido na barra lateral.

## O que já foi construído

- **Modelo de dados genérico** (`src/model/types.ts`): grafo tipado (EntityType, Entity, Relation) sem assumir hierarquia fixa em árvore — a hierarquia sai da ordem dos anéis escolhida + arestas existentes. O dataset tem `name` (vira o sol) e entidades podem ter `properties` livres.
- **Girar pra selecionar** com filtragem em cascata (`src/components/RingGroup.tsx`, `src/state/orbitState.ts`): arrastar/teclado (setas ←→) rotaciona um anel; ao soltar, o candidato mais próximo do eixo é selecionado e os anéis mais externos recalculam. Selecionar uma entidade **emprestada** de um vizinho propaga a mudança pra trás: os anéis internos re-selecionam os ancestrais reais dela e a cascata recomeça dali (`backPropagateSelection` em `src/model/selectors.ts`).
- **Reordenar anéis** arrastando o rótulo do tipo — que fica sobre o eixo de referência, logo antes do planeta selecionado do anel — radialmente (ou a trilha vazia, quando visível) (`src/components/RingTrack.tsx`): troca a posição de dois anéis vizinhos, mudando qual tipo de entidade é "pai" de qual.
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

- **Permitir conexão com banco Postgres** usando as foreign keys como relacionamentos. Precisa de decisão de arquitetura: um script offline que introspecta o schema e gera o JSON do dataset, ou um backend pequeno servindo o dataset em tempo real.
- **Clique também seleciona**: hoje o clique só abre a barra lateral; talvez girar o anel até o planeta clicado ao mesmo tempo.
