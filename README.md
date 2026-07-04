# Orbit Explorer

## Objetivo

Explorar dados relacionais (tabelas, bancos, ontologias) com hierarquia/relações entre entidades de um jeito mais intuitivo que o grafo "flat" clássico. A metáfora é um sistema solar: cada tipo de entidade é uma órbita (anel concêntrico), cada instância é um "planeta" nessa órbita. Um retângulo (a tela) funciona como janela sobre essas órbitas — não mostramos o círculo inteiro, só a fatia que cabe na janela, e o resto some/aparece conforme você gira.

Interação central: arrastar um anel gira todos os seus planetas juntos até que um deles alinhe no eixo de referência (a linha horizontal que atravessa todos os anéis) — esse é o selecionado. Selecionar um planeta atualiza em cascata os anéis mais externos, mostrando só as entidades relacionadas. Também dá pra arrastar um anel radialmente pra trocar sua posição com o vizinho, mudando a hierarquia de navegação.

## Como rodar

```bash
npm install
npm run dev
```

Dataset de exemplo em `src/data/monuments.json` (Categoria → Continente → País → Cidade → Monumento), recriando o rascunho original do projeto.

## O que já foi construído

- **Modelo de dados genérico** (`src/model/types.ts`): grafo tipado (EntityType, Entity, Relation) sem assumir hierarquia fixa em árvore — a hierarquia sai da ordem dos anéis escolhida + arestas existentes.
- **Girar pra selecionar** com filtragem em cascata (`src/components/RingGroup.tsx`, `src/state/orbitState.ts`): arrastar/teclado (setas ←→) rotaciona um anel; ao soltar, o candidato mais próximo do eixo é selecionado e os anéis mais externos recalculam.
- **Reordenar anéis** arrastando radialmente (`src/components/RingTrack.tsx`): troca a posição de dois anéis vizinhos, mudando qual tipo de entidade é "pai" de qual.
- **Janela retangular + scroll infinito** (`src/model/selectors.ts::buildRingDisplayList`, geometria em `src/geometry/ring.ts`): os anéis não mostram o círculo inteiro, só uma janela; o espaçamento entre planetas é fixo (não esticado pra preencher 360°), então poucos itens não ficam vazios e muitos não ficam espremidos. Suporta múltiplas voltas sem travar.
- **Preenchimento por vizinhança**: quando a entidade selecionada não tem filhos suficientes pra preencher a janela, o anel seguinte pega emprestado das entidades vizinhas (acima/abaixo) do anel pai — ex: Ásia selecionada só tem Japão/China, então Peru (de América do Sul, vizinha acima) aparece acima de Japão.
- **Esmaecimento gradual**: planetas longe do eixo central vão ficando mais transparentes em vez de sumir de repente, até um corte suave nas bordas da janela.
- **Visual**: tema "astrolábio/orrery" — céu índigo profundo, anéis gravados finos, seleção em latão com brilho, rótulos serifados. Acessibilidade básica (foco por teclado, `prefers-reduced-motion`).

## Bugs conhecidos

- **Coerência entre anéis ao selecionar item emprestado**: se você usa o scroll infinito pra selecionar uma entidade que foi "emprestada" de um vizinho (não do pai realmente selecionado — ex: selecionar Peru no anel de países enquanto o anel de continentes ainda mostra Ásia), os anéis mais internos (continente) **não** atualizam pra refletir essa escolha. O resultado fica visualmente incoerente: o país mostra Peru, mas o continente ainda destaca Ásia, mesmo Peru sendo do país América do Sul. Precisa: ao confirmar uma seleção que veio de um vizinho emprestado, propagar a mudança pra trás (atualizar a seleção dos anéis mais internos também), e daí recascatear pra frente a partir dali.

## Planejado

- **Linhas de conexão entre entidades relacionadas**, ecoando o rascunho original: uma linha sutil ligando a entidade selecionada de um anel às suas relacionadas no anel seguinte (e talvez às "emprestadas" também, pra deixar claro de onde vieram).
