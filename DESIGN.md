# Redesign visual — setembro de 2026

## Estrutura e decisões

O aplicativo continua estático: HTML, CSS e módulos JavaScript nativos, com o SDK do Trello. As seis abas, os cálculos, o cache, a persistência, os filtros e as exportações mantêm suas implementações existentes. Não há framework, bundler, package.json, lint ou typecheck configurados.

O dashboard já compartilhava componentes para KPIs, tabelas, seletores, painéis e modais. A largura máxima de 980px comprimia seis KPIs; navegação e cabeçalhos de modais usavam preto intenso; havia estilos duplicados nos iframes dos cards e valores de raio e tipografia inconsistentes.

- `css/tokens.css`: cores, superfícies, tipografia, espaçamento, raios, sombras, movimento e blur compartilhados.
- `css/dashboard.css`: base existente revisada, largura máxima de 1440px, grids responsivos, navegação translúcida e superfícies opacas para dados.
- `css/card-surfaces.css`: aplicação dos mesmos fundamentos aos dois iframes de card.
- `js/ui-icons.js`: ícones SVG com traço consistente, sem dependência adicional. Emojis que fazem parte dos nomes reais das listas do Trello permanecem como dados.

A fonte de sistema prioriza leitura e números; BW Modelica permanece na assinatura da marca. O amarelo continua presente na marca, ações principais e estado ativo. O Health Score preserva valor, status e progresso; recebe contexto e maior separação do insight prioritário. KPIs separam valor, unidade, meta e status textual. O alerta de SLA usa uma superfície neutra e uma ação acessível por teclado.

Os modais receberam Escape, contenção do foco, identificação de diálogo e retorno ao controle de origem. Preferências de movimento reduzido são respeitadas. Sem suporte a backdrop-filter, a navegação mantém uma superfície clara legível.

## Verificação reproduzível

Os testes de navegador usam somente dados fictícios e um SDK Trello simulado. Todas as requisições HTTPS são interceptadas. Nunca execute esses testes apontando para produção.

1. Sirva esta pasta em `http://127.0.0.1:8765` (por exemplo, `python -m http.server 8765 --bind 127.0.0.1`).
2. Instale Playwright em uma pasta temporária: `npm install --prefix <pasta-temporaria> playwright`.
3. Execute `node tests/visual-smoke.cjs <pasta-temporaria>/node_modules/playwright [dashboard-original.html]`.

O navegador padrão é o Chrome instalado no Windows. A variável `QA_BROWSER` permite indicar outro executável Chromium. O argumento opcional final permite comparar os KPIs e o Health Score com o HTML extraído do backup. As capturas são gravadas na pasta `design-review`, ao lado da pasta do projeto.

Cobertura: seis abas; grades em 1440, 1024, 768, 390 e 320px; ausência de overflow horizontal da página; modal pelo teclado, Escape e retorno do foco; alternância Nº/%; média/mediana; expansão de primeira entrega; estado vazio; exceções JavaScript. Tabelas largas continuam com rolagem interna em telas pequenas.

Os módulos `core-*` foram comparados byte a byte com o backup. Todos os módulos e scripts inline passaram por verificação de sintaxe JavaScript; `git diff --check` também foi executado. Não existe etapa de build, lint ou typecheck para executar neste projeto estático.

Validação local com dados simulados não substitui a conferência final dentro do iframe real do Trello. Publicação e testes com dados autenticados não foram executados nesta alteração.
