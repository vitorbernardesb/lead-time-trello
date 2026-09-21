# Carregamento do dashboard

O dashboard é uma aplicação estática com módulos ES. A fila compartilhada mantém
quatro chamadas simultâneas, até seis disparos por segundo, retentativas limitadas
e timeout de 20 segundos por tentativa.

## Fluxo

1. Buscar metadados e somente cards abertos. Aplicar o filtro de listas do fluxo.
2. Reutilizar históricos completos com `dateLastActivity` igual ao atual.
3. Para mais de 12 históricos ausentes, paginar ações do board desde o marco de
   primeira entrega. Agrupar por ID do card. Se a criação do card não estiver
   presente, buscar seu histórico individual completo. Para pequenas atualizações,
   consultar apenas os cards alterados.
4. Calcular e mostrar os indicadores principais, incluindo a vazão.
5. Em segundo plano, buscar metadados de cards arquivados sem descrições. Processar
   somente os arquivados elegíveis. Atualizar a primeira entrega e os consumidores
   desse histórico sem substituir os indicadores dos cards abertos.

Uma falha no histórico não é interpretada como ausência de movimentações. Falhas
nos arquivados deixam o dashboard utilizável, com aviso e opção de tentar novamente.
O progresso informa a quantidade processada e a página em leitura.

## Armazenamento

- Resumo dos cards abertos: localStorage, validade de cinco minutos.
- Históricos por card: IndexedDB, separados por board e por escopo aberto/arquivado.
- Resumo de arquivados: IndexedDB, validade de cinco minutos.
- Sem acesso ao IndexedDB: cache em memória e aviso no console; a aplicação continua.
- O cache legado de ações no localStorage é removido ao salvar o resumo novo.

O marco temporal não elimina históricos mais antigos: cards sem criação na janela
do board seguem pelo fallback individual. A paginação só é considerada completa
quando recebe uma página menor que 1.000 ações; cursor repetido gera erro.

## Validação

`node tests/history-loader.mjs` valida carga agrupada, atualização incremental,
fallback para histórico antigo/importado, paginação, falhas e cache em memória.

Com o servidor local na porta 8765 e Playwright disponível:

- `node tests/loading.cjs <caminho-playwright>`: arquivados deliberadamente lentos,
  indicadores disponíveis antes deles, persistência entre recargas e ausência de
  consultas de históricos já armazenados.
- `node tests/loading.cjs <caminho-playwright> --archive-failure`: falha dos
  arquivados, preservação dos KPIs e recuperação pelo botão de nova tentativa.
- `node tests/loading.cjs <caminho-playwright> --live`: benchmark somente de leitura
  no board configurado no teste. Escritas do SDK são simuladas; nenhum snapshot ou
  configuração é salvo no Trello. Compara seis históricos com consultas individuais.

Medição inicial em 21/09/2026: indicadores em 6,7 s; arquivados completos em 18,5 s;
25 requisições na carga fria. Recarga com históricos persistidos: quatro requisições
e nenhuma consulta de ações. Estes tempos são observações locais, não um SLA;
volume, rede, falhas e limites compartilhados do Trello podem alterar o resultado.
