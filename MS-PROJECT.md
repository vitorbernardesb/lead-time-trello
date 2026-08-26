# Integração Trello → Microsoft Project

Camada de exportação que transforma os cards do board em um **cronograma real** do MS
Project, usando os indicadores de tempo que o Power-Up já calcula.

Vive na aba **MS Project** do dashboard. É **100% aditiva**: não altera nenhum KPI,
fórmula, filtro ou cache existente (o diff de implementação é de 1246 inserções e
**0 deleções**). A exportação antiga — o botão **Relatório** no board — continua
funcionando exatamente como antes.

---

## 1. Como os dados são convertidos

```
Trello                Power-Up                      Camada MS Project              Arquivo
──────                ────────                      ─────────────────              ───────
cards + actions  →  fetchData()                →   temposDoCard()            →   .xml (MSPDI)
                    buildTimeline()                base histórica (medianas)      .xlsx (auditoria)
                    computeLeadTime()              duração + datas
                    computePrimeiraEntrega()       hierarquia + predecessoras
                    stages[] serializado           validação
                          ↓
                    cachedData (localStorage, TTL 5 min)
                          └──────── a camada MS Project lê SÓ daqui ────────┘
```

A exportação **não faz nenhuma chamada à API do Trello**. Ela consome `cachedData`,
que a aba *Tempo real* já carregou, e reutiliza o motor de tempo existente
(`businessHoursRaw`, `countBusinessDays`, `median`, `mean`) sobre a timeline
`card.stages[]` que o `fetchData` já serializa. Por isso a aba exige que a aba
*Tempo real* tenha carregado antes — igual a *Detalhamento* e *Análises*.

### Mapeamento Trello → MS Project

| Trello | MS Project |
|---|---|
| Nome do board | Nome do projeto (nível 1) |
| Etiqueta que **não** é pessoa (a 1ª) | Cliente (nível 2) |
| Lista do fluxo | Tarefa-resumo de etapa (nível 3) |
| Card | Tarefa (nível 4) |
| Etiqueta de pessoa (lista configurada) | Resource + Assignment |
| Membros do card (`idMembers`) | Resource — **só como fallback** |
| Esforço ativo / mediana histórica | Duration |
| 1ª entrada em produção | Start / ActualStart |
| Entrada em `Concluído 🏆` | ActualFinish |
| Data de entrega (`due`) | **Deadline** (nunca Finish) |
| Etapa no fluxo | % Complete |
| Etiqueta de prioridade de negócio | **Priority** |
| Nível de Esforço (+ atraso) | `Number1` **Esforço/Urgência** (informativo) |
| Ordem canônica das listas | Predecessors (FS) |
| Jornada 09–18 + feriados BR | Calendar |
| ID, URL, cliente, etapa, nível, status, tempos | Campos customizados `Text1`–`Text10` |
| Auditoria completa da estimativa | `Notes` da tarefa |

Cards **arquivados** entram apenas como **base histórica** para as medianas — nunca
viram tarefa no cronograma.

---

## 2. Como a duração é calculada

A `Duration` é **esforço**, não tempo decorrido. O tempo em fila é descontado.

### Classificação das listas

| Bucket | Listas | Entra na duração? |
|---|---|---|
| **Trabalho ativo** | `Captação de Imagem 🎥`, `Em andamento 💪`, `Alterações ✏️`, `Revisão Interna 🔎` | **Sim** |
| Fila interna | `Planejamento`, `A fazer 👇`, `🛑URGÊNCIAS🛑`, `⚠️Atrasos⚠️`, `Revisões em Atraso ⏰` | Não → campo *Tempo em fila* |
| Espera externa | `Revisão Externa 🧐` | Não → campo auxiliar |
| Marco final | `Concluído 🏆` | Não |

Reclassificar uma lista é mover o nome entre os arrays `ETAPAS_ATIVAS` / `ETAPAS_EXTERNA`
no topo do módulo. Nada mais precisa mudar.

### Medição

Soma das **horas úteis** de cada permanência nas listas de trabalho ativo, via
`businessHoursRaw` — a mesma função do indicador *Tempo até 1ª entrega*, com jornada
**09:00–18:00, seg–sex = 9h/dia**. Reentradas somam (2 passagens por `Em andamento`
contam as duas). Permanências posteriores à conclusão são descartadas e as em curso
são cortadas na data de conclusão, então reabrir um card não contamina o histórico.

### Cascata de origem

| Ordem | Regra | Marcação |
|---|---|---|
| 1 | Card concluído → **esforço ativo real dele** | `REAL` |
| 2 | Mediana do **Nível de Esforço** (exige n ≥ 3) | `ESTIMADO` |
| 3 | Mediana da **etapa atual** (tempo típico de permanência, n ≥ 3) | `ESTIMADO` |
| 4 | Mediana **global** do board | `ESTIMADO` |
| 5 | **SLA** configurado da etapa | `ESTIMADO` |
| 6 | 1 dia útil assumido (sem dado algum) | `ESTIMADO` + aviso |

**Mediana**, não média — um card que ficou 40 dias parado não distorce a estimativa.

Toda estimativa é explícita no arquivo:

- `DurationFormat = 39` + `Estimated = 1` → o Project mostra **`5d?`** com interrogação.
- Dado real → `DurationFormat = 7`, sem interrogação.
- O `Notes` da tarefa registra a origem exata: *"Mediana do nível MÉDIO (n=7)"*.

### Precedência das opções

Com **Preservar datas reais dos concluídos** ligado (padrão), um card concluído recebe
`Duration = período real decorrido` — porque `ActualStart` + `ActualFinish` reais
determinam a duração e o Project a recalcularia de qualquer forma. Isso vale mesmo se a
*Fonte da duração* for outra. O esforço ativo **não se perde**: fica no `Notes` e no
XLSX. Desligue a opção para ter `Duration = esforço` também nos concluídos, ao custo de
o término deixar de ser a data real.

---

## 3. Como os recursos são identificados

**Só as etiquetas da lista configurada viram pessoa.** Nunca "qualquer etiqueta".

Padrão: Gabriel Damasceno, Wendel, Bruna, Igor, Rodrigo, Welber, Carol, Vitor, Farlem,
Vic — editável na própria aba e salvo no board.

### Correspondência tolerante, mas sem falso-positivo

Acento, caixa, emoji e pontuação são ignorados; a comparação é por **palavra inteira**.

| Etiqueta | Resultado |
|---|---|
| `Gabriel Damasceno`, `gabriel damasceno` | Gabriel Damasceno |
| `Carol💻`, `Vic 🫡` | Carol · Vic |
| `Gabriel` (primeiro nome único na lista) | Gabriel Damasceno |
| `Vitor Bernardes` | Vitor |
| `Victoria Store`, `Vicente` | **não é pessoa** |
| `Vídeo`, `Social Media` | **não é pessoa** |

Se dois nomes configurados dividissem o primeiro nome, a âncora por primeiro nome é
desativada nos dois — ambiguidade nunca é resolvida por chute.

### Destino das outras etiquetas

1. Primeira etiqueta não-pessoa → **Cliente** (nível 2 da hierarquia)
2. Demais → campo customizado *Etiquetas* (via `Notes`)
3. Sem etiqueta de cliente → grupo **“Sem cliente”**, sempre por último

### Múltiplas pessoas e fallback

- Todas entram, **100% de alocação cada**: `Duration` inalterada, `Work` total dobrado.
- Sem etiqueta de pessoa, usa os **membros do card**; o `Notes` registra *(via membro do card)*.
- Sem nenhuma das duas → aviso `semRecurso` na validação (a atividade ainda exporta).

---

## 4. Como as predecessoras são definidas

As **tarefas-resumo de etapa** de um mesmo cliente encadeiam em **Finish-to-Start**, na
ordem canônica de `FLOW_LISTS`:

```
Cliente Alfa
├─ Planejamento              (sem predecessora)
├─ A fazer 👇                pred: Planejamento
├─ Em andamento 💪           pred: A fazer 👇
│    ├─ Vídeo institucional  ┐
│    └─ Reels quinzenal      ┴ em PARALELO (sem predecessora entre si)
├─ Revisão Interna 🔎        pred: Em andamento 💪
└─ Concluído 🏆              pred: Revisão Interna 🔎
```

- As atividades dentro de uma etapa ficam **em paralelo** — o Trello não expressa
  dependência entre cards, e inventá-la produziria um cronograma falso.
- Cada corrente é **local ao cliente**: nenhum cliente depende de outro.
- **Ciclo é estruturalmente impossível** (ordem canônica + corrente local). A validação
  confirma a cada exportação que `predecessora.UID < tarefa.UID`.
- Só existem etapas que **têm** atividades — etapas vazias não aparecem.

---

## 5. Como as datas são determinadas

| Situação do card | Start | Finish | % | Duration |
|---|---|---|---|---|
| **Concluído** | `ActualStart` = 1ª entrada em produção | `ActualFinish` = entrada em `Concluído 🏆` | 100 | período real |
| **Em andamento** | `ActualStart` real | calculado (Start + duração) | pela etapa | esforço estimado |
| **Não iniciado** | agendado pela predecessora | calculado | 0 (ou pela etapa) | esforço estimado |

- Datas reais entram como **ActualStart / ActualFinish**, não como *constraints* — os
  valores reais são preservados sem gerar conflito de restrição no Project.
- O `due` do Trello vira **Deadline**, nunca `Finish`: o Project sinaliza o estouro de
  prazo sem distorcer a duração.
- Início do projeto = **data real mais antiga** entre as atividades exportadas.
- Agendamento respeita jornada de 9h, fim de semana e **feriados nacionais**: 9 fixos
  (incluindo 20/11) + 4 móveis derivados da Páscoa (Carnaval seg/ter, Sexta-feira Santa,
  Corpus Christi), escritos como exceções do calendário.

**% Complete por etapa:** Planejamento 0 · A fazer / URGÊNCIAS 10 · Captação 25 ·
Em andamento / Atrasos 40 · Alterações 55 · Revisão Interna 70 · Revisão Externa /
Revisões em Atraso 90 · Concluído 100.

**Priority vs. Esforço/Urgência.** São dois campos distintos, e a diferença importa:

| Campo | O que mede | Efeito no Project |
|---|---|---|
| **`Priority`** | Prioridade de **negócio** | **Governa o `Nivelar Tudo`** — o Project atrasa primeiro as tarefas de menor Priority |
| **`Number1` "Esforço/Urgência"** | Quão trabalhoso/urgente é o card | Nenhum — puramente informativo |

`Esforço/Urgência` = MUITO ALTO 900 · ALTO 700 · MÉDIO 500 · BAIXO 300 · sem nível 500;
**+100 se o card estiver vencido** (teto 1000). Era o valor gravado em `Priority` até
esta mudança.

`Priority` vem da cascata:

1. Card com etiqueta listada em **Etiquetas de prioridade de negócio** → **900**
2. Senão → o próprio `Esforço/Urgência` (fallback)

Como a lista de etiquetas nasce **vazia**, quem não configurar nada tem `Priority`
exatamente igual ao de antes. Configurar passa a fazer o nivelamento automático
respeitar a importância do cliente em vez do tamanho do card.

> **Etiquetas de prioridade não competem por Cliente.** Elas são retiradas da
> classificação **antes** da escolha do cliente, igual às etiquetas de pessoa. Sem
> isso, uma etiqueta `VIP` seria adotada como nome do cliente e o cliente real cairia
> em "outras etiquetas", deslocando a hierarquia inteira. O reconhecimento usa o mesmo
> motor das pessoas: tolerante a acento/caixa/emoji, mas exigindo palavra inteira —
> `VIP 🔥` casa, `VIParque` não.

> **Nota sobre feriados:** só o **agendamento** conhece feriados. A **medição** (os KPIs
> e as horas úteis) segue sem feriados, exatamente como antes — nenhuma fórmula existente
> foi tocada. Isso é intencional: o cronograma não promete entrega em 25/12, e os
> indicadores continuam comparáveis com o histórico.

---

## 6. Como lidar com dados insuficientes

Nada é gerado em silêncio. Antes de exportar, a aba mostra o diagnóstico completo, e
cada linha problemática é clicável (abre os cards no mesmo modal do dashboard).

| Severidade | Ocorrência | Efeito |
|---|---|---|
| 🔴 **Bloqueio** | Atividade sem nome | Excluída do arquivo |
| 🔴 **Bloqueio** | Duração inválida (≤ 0) | Excluída do arquivo |
| 🟡 Aviso | Data final anterior à inicial | Datas reais descartadas; vira estimativa |
| 🟡 Aviso | Sem histórico para estimar | 1 dia útil assumido |
| 🟡 Aviso | Nenhum recurso reconhecido | Exporta sem Resource |
| 🟡 Aviso | Etapa fora das listas do fluxo | Exporta ao fim da corrente |
| ⚪ Info | Sem etiqueta de cliente | Agrupada em “Sem cliente” |

Bloqueios **nunca** entram no arquivo. Avisos entram por padrão — marque **Excluir
atividades com aviso** para deixá-los de fora. A aba *Validação* do XLSX repete tudo,
com o nome de cada card afetado.

---

## 7. Manual de uso

### Exportar

1. Abra o **Dashboard** e espere a aba *Tempo real* carregar (é ela que traz os dados).
2. Vá na aba **MS Project**.
3. Confira o painel **Validação**. Clique em *ver cards* em qualquer linha para ver quais
   cards estão com problema — e corrija no Trello se quiser, antes de exportar.
4. Ajuste a **Configuração**, se precisar (as escolhas ficam salvas no board):
   - **Fonte da duração** — esforço ativo (padrão) · lead time bruto · sempre mediana por nível
   - **Incluir cards já concluídos** — ligado dá a linha de base do que foi entregue
   - **Preservar datas reais dos concluídos** — ligado por padrão (ver §2)
   - **Excluir atividades com aviso**
   - **Pessoas reconhecidas nas etiquetas** — uma por linha
   - **Etiquetas de prioridade de negócio** — uma por linha (ex.: `VIP`). Vazio por
     padrão; ver §5 para o efeito em `Priority` e na escolha do Cliente
5. Clique em **⬇ Cronograma (.xml para o MS Project)**.
6. No MS Project: **Arquivo → Abrir → Cronograma** e escolha o `.xml`. Na caixa de
   importação, marque **“Como um novo projeto”**.

### Ver o cronograma no Project

- **Gantt Chart** já mostra a hierarquia Projeto › Cliente › Etapa › Atividade.
- **View → Tables → More Tables** ou insira colunas para ver os campos customizados:
  *Trello Card ID, Trello Card URL, Etapa atual, Cliente, Nível de Esforço, Status,
  Lead time bruto, Tempo até 1ª entrega, Tempo em fila, Tempo por etapa*.
- Duração com **`?`** = estimativa. Sem `?` = dado real medido.
- Clique no ícone de hyperlink da tarefa para **abrir o card no Trello**.
- Passe o mouse no indicador de nota (`📝`) para a auditoria completa da atividade.
- **View → Resource Sheet** lista as pessoas; **Resource Usage** mostra a carga de cada uma.

### Planilha de auditoria (.xlsx)

O botão **⬇ Planilha de auditoria** gera as mesmas informações em 3 abas — use para
conferir os números fora do Project:

| Aba | Conteúdo |
|---|---|
| **Cronograma** | 26 colunas: as do Project + esforço, fila, espera externa, breakdown por etapa, base e origem da duração |
| **Base histórica** | Medianas por nível de esforço e por etapa (n, mediana, média, mín, máx) |
| **Validação** | O resumo e a lista de cards de cada ocorrência |

### Por que não `.mpp`

O `.mpp` é formato binário proprietário, sem especificação pública de escrita —
impossível de gerar no navegador. O `.xml` (schema **MSPDI**, "Project 2003+ XML") é o
formato de intercâmbio **oficial da Microsoft**: abre com duplo clique e carrega
hierarquia, durações, predecessoras, recursos, atribuições, calendário com feriados e
campos customizados. A importação por planilha **não** carrega calendário nem
atribuições de recurso — é por isso que o `.xml` é o arquivo principal e o `.xlsx` é só
conferência.

---

## Notas técnicas

### Performance

- **Zero** chamadas REST à API do Trello. Só `t.board('name')` (chamada do cliente
  Power-Up, uma vez por sessão) e `t.get`/`t.set` de `pluginData` para a configuração.
- Base histórica **memoizada** por load, invalidada quando `cachedData` é substituído.
- Bibliotecas (`xlsx-js-style`) carregadas **on-demand**, só ao clicar em exportar.
- Cache, TTL, fila de API com pacing, paginação e todas as otimizações existentes
  permanecem intactos.
- Fallback: se o CDN do XLSX falhar, a planilha sai como **CSV**.

### Alterações no código existente

Quatro, todas puramente aditivas (nenhuma linha modificada ou removida):

| Onde | O quê |
|---|---|
| `dashboard.html` — barra de abas | botão `MS Project` |
| `dashboard.html` — corpo | `<div id="tab-msproject">` |
| `dashboard.html` — `switchTab()` | 1 linha: `if (name === 'msproject') MSP.render();` |
| `dashboard.html` — `fetchData()` | `due` e `dueComplete` no objeto processado |

Os dois campos novos vêm do **mesmo request de cards que já existia** — zero chamada
extra. Nenhum KPI os lê (todos usam `hasDue`/`isLate`, inalterados). Cache antigo sem
esses campos degrada para `Deadline` nulo, sem erro.

### Configuração no código

No topo do módulo `MSP` (`js/msproject.js`), em constantes nomeadas: `PESSOAS_PADRAO`,
`ETAPAS_ATIVAS`, `ETAPAS_EXTERNA`, `PCT_ETAPA`, `PRIO_NIVEL`, `PRIO_NEGOCIO`,
`MIN_AMOSTRA` (amostra mínima = 3), `EXT` e `EXT_NUM` (campos customizados). A jornada é
**lida** de `WORK_START_HOUR`/`WORK_END_HOUR`, as mesmas constantes que
`businessHoursRaw` usa — a duração exportada é, por construção, a mesma que o dashboard
mede.

> **`FieldID` do `Number1`:** os campos `Number*` **não** seguem a progressão `+3` dos
> `Text*`. `Number1` é `188743767`. Confirmado como bem-formado e na ordem correta da
> `sequence` MSPDI; a aceitação do campo pelo Project ainda precisa de uma importação
> real para confirmação definitiva.

### Limitações conhecidas

- Atividades concluídas com datas reais podem gerar **folga negativa** quando a corrente
  de etapas as colocaria depois. É esperado: histórico real não se reagenda, e o Project
  sinaliza corretamente.
- Feriados **municipais/estaduais** não estão na lista (só os nacionais). Ajustáveis em
  `feriadosDoAno`.
- A hierarquia usa a **etapa atual** do card. Um card que já passou por várias etapas
  aparece só na etapa onde está agora; o histórico completo fica no campo *Tempo por
  etapa* e no `Notes`.

### Inconsistência registrada (não corrigida)

O relatório XLSX antigo (botão **Relatório** no board) tem uma coluna
`Lead Time Total (d.u.)` que é a **soma dos dias úteis em todas as listas do fluxo** —
métrica diferente do KPI6 *Tempo de entrega* do dashboard, que é
`dias úteis(1ª entrada em produção → conclusão)`. São dois números com nomes parecidos e
definições distintas. **Nada foi alterado**; fica registrado para decisão sua.

### Testes

> **Não há suíte de testes versionada neste repositório.** Uma versão anterior deste
> documento afirmava "237 assertivas automatizadas" — a alegação era falsa: nenhum
> arquivo de teste está sob controle de versão. Registrado aqui para não induzir a erro.

A verificação hoje é **manual e reproduzível**. Roteiro por mudança:

**Priority de negócio vs. Esforço/Urgência**

1. Deixe **Etiquetas de prioridade de negócio** vazio → exporte. Em toda tarefa,
   `Priority` deve ser igual a `Number1` (comportamento anterior preservado).
2. Crie um card com as etiquetas `VIP` **e** `Cliente Delta` (nessa ordem) e uma
   pessoa. Configure `VIP` na lista → exporte.
3. No XML, a tarefa desse card deve trazer `<Priority>900</Priority>`, o
   `ExtendedAttribute` de `FieldID 188743767` com o valor do nível de esforço, e
   `Text4` = `Cliente Delta`.
4. No Gantt, a atividade tem de aparecer sob **Cliente Delta** — nunca sob "VIP".

Os ganchos `MSP._construir()`, `MSP._gerarXML(p)`, `MSP._cfg({...})`, `MSP._agendar()`
e `MSP._planilha.*` permitem rodar tudo isso no console sem clicar na UI.
