// ═══════════════════════════════════════════════════════════════════════════
//  MSP — PONTE TRELLO → MICROSOFT PROJECT   (camada 100% ADITIVA)
//  ─────────────────────────────────────────────────────────────────────────
//  Nada aqui altera KPI, fórmula, filtro ou cache existente. O módulo LÊ
//  `cachedData` (já carregado pela aba Tempo real) e REUTILIZA o motor de tempo
//  do Power-Up — businessHoursRaw, countBusinessDays, median, mean e a timeline
//  serializada em card.stages[]. ZERO chamadas novas à API do Trello.
//
//  Pipeline:
//    cachedData → temposDoCard() → base histórica (medianas) → duração
//    → datas → hierarquia (Projeto>Cliente>Etapa>Atividade) → predecessoras
//    → validação → XML MSPDI (.xml) + XLSX de auditoria
//
//  Por que XML e não .mpp: o .mpp é formato binário proprietário, sem
//  especificação pública de escrita — impossível de gerar em JS no browser. O
//  .xml (schema MSPDI / "Project 2003+ XML") é o formato de intercâmbio oficial
//  da Microsoft: o Project abre com duplo clique e importa hierarquia, durações,
//  predecessoras, recursos, atribuições, calendário com feriados e campos
//  customizados — coisas que a importação por planilha NÃO carrega.
// ═══════════════════════════════════════════════════════════════════════════
import { FLOW_LISTS, PRODUCAO_ATIVA, NIVEIS_ESFORCO, DEFAULT_SLA, DEFAULTS, COR_NIVEL } from './config.js';
import { t, cachedData } from './state.js';
import { debounce, round1, mean, median } from './core-util.js';
import { WORK_START_HOUR, WORK_END_HOUR, countBusinessDays, businessHoursRaw } from './core-time.js';
import { getConcludedAt, computeLeadTime } from './core-metrics.js';
import { escHtml, fmtDateTime, fmtHoras, fmtDias } from './core-fmt.js';
import { downloadCSV, loadXLSXLib, setBtnLoading, triggerDownload } from './core-io.js';

// `CP` entra por injecao (o modulo usa os modais dos Paineis Personalizados) —
// importar direto criaria acoplamento de ordem entre dois modulos de aba.
export function createMSP(deps) {
  const { fetchData, loadRealtime, CP } = deps;

  const MSP = (function() {

    // ══════════════ 1. CONFIGURAÇÃO DECLARATIVA ══════════════

    // Pessoas reconhecidas nas ETIQUETAS dos cards (ETAPA 4 do briefing).
    // Nunca "qualquer etiqueta vira pessoa": só o que estiver nesta lista.
    // Editável na própria aba e persistida no board (pluginData 'mspConfig').
    var PESSOAS_PADRAO = ['Gabriel Damasceno','Wendel','Bruna','Igor','Rodrigo','Welber','Carol','Vitor','Farlem','Vic'];

    // Classificação das listas do fluxo para efeito de DURAÇÃO (esforço):
    //   ATIVAS  → trabalho sendo executado        → SOMA esforço (vira Duration)
    //   FILA    → espera interna (backlog/atraso)  → NÃO soma (vai p/ "Tempo em fila")
    //   EXTERNA → bola com o cliente               → NÃO soma (espera externa)
    // "Concluído 🏆" não entra em nenhum bucket: é o marco final, não trabalho.
    // Reclassificar uma lista = mover o nome de array. Nada mais precisa mudar.
    var ETAPAS_ATIVAS  = ['Captação de Imagem 🎥', 'Em andamento 💪', 'Alterações ✏️', 'Revisão Interna 🔎'];
    var ETAPAS_EXTERNA = ['Revisão Externa 🧐'];
    // (o restante das FLOW_LISTS é fila por eliminação — ver temposDoCard)

    // % Complete por etapa do fluxo: progresso na esteira de produção.
    var PCT_ETAPA = {
      'Planejamento': 0, 'A fazer 👇': 10, '🛑URGÊNCIAS🛑': 10, 'Captação de Imagem 🎥': 25,
      'Em andamento 💪': 40, '⚠️Atrasos⚠️': 40, 'Alterações ✏️': 55, 'Revisão Interna 🔎': 70,
      'Revisão Externa 🧐': 90, 'Revisões em Atraso ⏰': 90, 'Concluído 🏆': 100
    };

    // Escala 0–1000 derivada do Nível de Esforço; +100 se vencido.
    // ATENÇÃO: isto mede ESFORÇO/URGÊNCIA, não importância de negócio. Desde a
    // separação (item 3), vai para o Number1 "Esforço/Urgência", NÃO para Priority
    // — porque Priority governa o algoritmo de nivelamento do MS Project, e
    // nivelar por "quão trabalhoso" atrasaria o cliente errado. Ver PRIO_NEGOCIO.
    var PRIO_NIVEL = { 'MUITO ALTO': 900, 'ALTO': 700, 'MÉDIO': 500, 'BAIXO': 300 };
    var PRIO_PADRAO = 500;
    // Priority de NEGÓCIO: cards com etiqueta de prioridade configurada (mspConfig
    // .etiquetasPrioridadeNegocio) recebem este valor. Sem nenhuma configurada, o
    // fallback é o próprio Esforço/Urgência — ou seja, comportamento idêntico ao
    // anterior enquanto ninguém configurar nada.
    var PRIO_NEGOCIO = 900;

    // Jornada: LIDA das constantes já usadas por businessHoursRaw (09–18 = 9h/dia).
    // Assim a duração exportada é a MESMA medida que o dashboard mostra, sem conversão.
    var HORAS_DIA = WORK_END_HOUR - WORK_START_HOUR;   // 9
    var MIN_AMOSTRA = 3;                                // amostra mínima p/ confiar na mediana
    var CFG_KEY = 'mspConfig';

    // Campos customizados do MS Project (Text1..Text10). FieldID é o identificador
    // numérico do campo no schema MSPDI — usar só Text1..Text10, cujos IDs são
    // estáveis e documentados (progressão +3). O Alias é o nome que aparece na coluna.
    var EXT = [
      { fid: '188743731', nome: 'Text1',  alias: 'Trello Card ID' },
      { fid: '188743734', nome: 'Text2',  alias: 'Trello Card URL' },
      { fid: '188743737', nome: 'Text3',  alias: 'Etapa atual' },
      { fid: '188743740', nome: 'Text4',  alias: 'Cliente' },
      { fid: '188743743', nome: 'Text5',  alias: 'Nível de Esforço' },
      { fid: '188743746', nome: 'Text6',  alias: 'Status' },
      { fid: '188743749', nome: 'Text7',  alias: 'Lead time bruto (d.u.)' },
      { fid: '188743752', nome: 'Text8',  alias: 'Tempo até 1ª entrega (h)' },
      { fid: '188743755', nome: 'Text9',  alias: 'Tempo em fila (h)' },
      { fid: '188743758', nome: 'Text10', alias: 'Tempo por etapa (h)' }
    ];
    // Campo numérico separado (item 3). Os FieldIDs de Number* NÃO seguem a
    // progressão +3 dos Text* — Number1 começa em 188743767 e sobe de 1 em 1.
    var EXT_NUM = { fid: '188743767', nome: 'Number1', alias: 'Esforço/Urgência (informativo)' };

    var CFG_PADRAO = {
      fonte: 'esforco',            // 'esforco' | 'bruto' | 'nivel'
      incluirConcluidos: true,
      preservarDatasReais: true,
      excluirComAviso: false,
      pessoas: PESSOAS_PADRAO.slice(),
      // Etiquetas que marcam prioridade de NEGÓCIO (ex.: 'VIP', 'Contrato Prioritário').
      // Vazio por padrão → Priority mantém exatamente o comportamento anterior.
      etiquetasPrioridadeNegocio: []
    };

    var cfg = null;               // config efetiva (carregada do board)
    var cfgCarregada = false;
    var boardNome = null;
    var _baseCache = null;        // { ref: cachedData, base: {...} }  memo por load
    var ultimoPacote = null;      // resultado do último construir() (p/ os botões)

    // ══════════════ 2. UTILITÁRIOS ══════════════

    function semAcento(s) {
      s = String(s === null || s === undefined ? '' : s);
      if (s.normalize) s = s.normalize('NFD').replace(/[\u0300-\u036F]/g, '');
      return s;
    }
    // Tokens alfanuméricos minúsculos: descarta acento, emoji e pontuação.
    // 'Carol💻' → ['carol'] · 'Gabriel Damasceno' → ['gabriel','damasceno']
    function tokens(s) {
      return semAcento(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    }
    function contemSequencia(hay, needle) {
      if (!needle.length || needle.length > hay.length) return false;
      for (var i = 0; i + needle.length <= hay.length; i++) {
        var ok = true;
        for (var j = 0; j < needle.length; j++) { if (hay[i + j] !== needle[j]) { ok = false; break; } }
        if (ok) return true;
      }
      return false;
    }
    // Prepara a lista de pessoas: cada uma com seus tokens e, quando o PRIMEIRO nome
    // é único na lista, uma "âncora" que permite reconhecer a etiqueta só pelo 1º nome
    // ('Gabriel' → Gabriel Damasceno). Se dois configurados dividissem o 1º nome, a
    // âncora é desativada nos dois — ambiguidade nunca é resolvida por chute.
    function construirPessoas(nomes) {
      var lista = (nomes || []).map(function(n) { return { nome: String(n).trim(), tk: tokens(n) }; })
        .filter(function(p) { return p.nome && p.tk.length; });
      var cont = {};
      lista.forEach(function(p) { cont[p.tk[0]] = (cont[p.tk[0]] || 0) + 1; });
      lista.forEach(function(p) { p.anchor = (p.tk.length > 1 && cont[p.tk[0]] === 1) ? p.tk[0] : null; });
      return lista;
    }
    // Etiqueta → nome da pessoa, ou null se a etiqueta não representa pessoa.
    // Tolerante a acento/caixa/emoji, mas exige PALAVRA INTEIRA: 'Victoria Store'
    // NÃO casa com 'Vic'; 'Vic 🫡' casa.
    function pessoaDaEtiqueta(label, pessoas) {
      var lt = tokens(label);
      if (!lt.length) return null;
      for (var i = 0; i < pessoas.length; i++) {
        var p = pessoas[i];
        if (contemSequencia(lt, p.tk)) return p.nome;
        if (p.anchor && lt.length === 1 && lt[0] === p.anchor) return p.nome;
      }
      return null;
    }

    // Etiqueta → é marca de prioridade de negócio? Reusa EXATAMENTE o mesmo
    // reconhecimento das pessoas (palavra inteira, tolerante a acento/caixa/emoji),
    // então 'VIP 🔥' casa com 'VIP' e 'Serviço VIParque' não casa.
    function construirMarcas(nomes) {
      return (nomes || []).map(function(n) { return { nome: String(n).trim(), tk: tokens(n) }; })
        .filter(function(m) { return m.nome && m.tk.length; });
    }
    function ehEtiquetaPrioridade(label, marcas) {
      var lt = tokens(label);
      if (!lt.length) return false;
      for (var i = 0; i < marcas.length; i++) if (contemSequencia(lt, marcas[i].tk)) return true;
      return false;
    }

    function h2d(h) { return round1(h / HORAS_DIA); }                       // horas úteis → dias úteis
    function nf(x) { return String(round1(x)).replace('.', ','); }
    function chaveDia(d) {
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    // ── Feriados (só o CALENDÁRIO do cronograma; os KPIs seguem sem feriados) ──
    // Páscoa por Meeus/Jones/Butcher → deriva Carnaval, Sexta-feira Santa e Corpus Christi.
    function pascoa(y) {
      var a = y % 19, b = Math.floor(y / 100), c = y % 100,
          d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25),
          g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30,
          i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7,
          m = Math.floor((a + 11 * h + 22 * l) / 451),
          mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
      return new Date(y, mes - 1, dia);
    }
    function feriadosDoAno(y) {
      var fixos = [[1,1,'Confraternização Universal'],[4,21,'Tiradentes'],[5,1,'Dia do Trabalho'],
        [9,7,'Independência'],[10,12,'N. Sra. Aparecida'],[11,2,'Finados'],
        [11,15,'Proclamação da República'],[11,20,'Consciência Negra'],[12,25,'Natal']];
      var out = fixos.map(function(x) { return { d: new Date(y, x[0] - 1, x[1]), nome: x[2] }; });
      var p = pascoa(y);
      function off(n, nome) { var d = new Date(p); d.setDate(d.getDate() + n); return { d: d, nome: nome }; }
      out.push(off(-48, 'Carnaval'), off(-47, 'Carnaval'), off(-2, 'Sexta-feira Santa'), off(60, 'Corpus Christi'));
      return out;
    }
    function montarFeriados(anoIni, anoFim) {
      var mapa = {}, lista = [];
      for (var y = anoIni; y <= anoFim; y++) {
        feriadosDoAno(y).forEach(function(f) {
          var k = chaveDia(f.d);
          if (!mapa[k]) { mapa[k] = f.nome; lista.push(f); }
        });
      }
      lista.sort(function(a, b) { return a.d - b.d; });
      return { mapa: mapa, lista: lista };
    }

    // ── Agenda: avanço de horas úteis respeitando jornada, fim de semana E feriados ──
    // NOVA lógica (não existe equivalente no Power-Up) — é a camada de transformação.
    // A MEDIÇÃO continua sendo businessHoursRaw (sem feriados, paridade com os KPIs);
    // só o AGENDAMENTO conhece feriados, que é o que o Project precisa para não
    // prometer entrega no dia 25/12.
    function ehDiaUtil(d, fer) {
      var dow = d.getDay();
      if (dow === 0 || dow === 6) return false;
      return !fer.mapa[chaveDia(d)];
    }
    function proximoInicioUtil(from, fer) {
      var d = new Date(from);
      for (var guard = 0; guard < 4000; guard++) {
        if (ehDiaUtil(d, fer)) {
          var ini = new Date(d); ini.setHours(WORK_START_HOUR, 0, 0, 0);
          var fim = new Date(d); fim.setHours(WORK_END_HOUR, 0, 0, 0);
          if (d < ini) return ini;
          if (d < fim) return d;
        }
        d.setDate(d.getDate() + 1); d.setHours(WORK_START_HOUR, 0, 0, 0);
      }
      return new Date(from);
    }
    function somarHorasUteis(from, horas, fer) {
      var cursor = proximoInicioUtil(from, fer);
      var rest = Math.max(0, horas);
      if (rest <= 1e-6) return cursor;
      for (var guard = 0; guard < 6000 && rest > 1e-6; guard++) {
        var fimDia = new Date(cursor); fimDia.setHours(WORK_END_HOUR, 0, 0, 0);
        var disp = (fimDia - cursor) / 3600000;
        if (disp >= rest) return new Date(cursor.getTime() + rest * 3600000);
        rest -= disp;
        var prox = new Date(cursor); prox.setDate(prox.getDate() + 1); prox.setHours(WORK_START_HOUR, 0, 0, 0);
        cursor = proximoInicioUtil(prox, fer);
      }
      return cursor;
    }

    // ══════════════ 3. TEMPOS DO CARD (reusa o motor existente) ══════════════
    // Percorre card.stages[] (timeline já serializada pelo fetchData) e reparte as
    // HORAS ÚTEIS de cada permanência em três buckets: trabalho ativo, fila interna
    // e espera externa. Usa businessHoursRaw — a MESMA função do indicador de 1ª
    // entrega —, então nenhum número novo é inventado.
    //   inicio  = 1ª entrada em PRODUCAO_ATIVA (idêntico ao início de computeLeadTime)
    //   fim     = concludedAt (idêntico a getConcludedAt)
    // Etapas posteriores à conclusão são descartadas e as permanências em curso são
    // cortadas na conclusão — o card reaberto não contamina o histórico.
    function temposDoCard(c) {
      var stages = Array.isArray(c.stages) ? c.stages : [];
      var fim = c.concludedAt ? new Date(c.concludedAt) : null;
      var agora = new Date();
      var r = { ativoH: 0, filaH: 0, externaH: 0, porEtapa: {}, inicio: null, primeiroAtivo: null, fim: fim };
      for (var i = 0; i < stages.length; i++) {
        var s = stages[i];
        var nome = (s.name || '').trim();
        var ent = new Date(s.enteredAt);
        if (isNaN(ent.getTime())) continue;
        if (fim && ent >= fim) continue;                        // pós-conclusão: fora
        var sai = s.leftAt ? new Date(s.leftAt) : (fim || agora);
        if (fim && sai > fim) sai = fim;                        // corta na conclusão
        if (!(sai > ent)) continue;
        var h = businessHoursRaw(ent, sai);                     // ◀ motor EXISTENTE
        r.porEtapa[nome] = (r.porEtapa[nome] || 0) + h;
        if (ETAPAS_ATIVAS.indexOf(nome) !== -1) {
          r.ativoH += h;
          if (!r.primeiroAtivo) r.primeiroAtivo = ent;
        } else if (ETAPAS_EXTERNA.indexOf(nome) !== -1) {
          r.externaH += h;
        } else if (nome !== 'Concluído 🏆') {
          r.filaH += h;
        }
        if (!r.inicio && PRODUCAO_ATIVA.indexOf(nome) !== -1) r.inicio = ent;
      }
      r.ativoH = round1(r.ativoH); r.filaH = round1(r.filaH); r.externaH = round1(r.externaH);
      Object.keys(r.porEtapa).forEach(function(k) { r.porEtapa[k] = round1(r.porEtapa[k]); });
      return r;
    }

    // ══════════════ 4. BASE HISTÓRICA (medianas reais) ══════════════
    // Amostra = cards CONCLUÍDOS, abertos + ARQUIVADOS elegíveis. Os arquivados
    // entram SÓ aqui (nunca viram tarefa), exatamente como no indicador de 1ª entrega.
    // Produz três níveis de mediana + o tempo típico por etapa (ETAPA 6 do briefing).
    function calcularBase(historico) {
      var porNivel = {}, amostrasEtapa = {}, global = [];
      NIVEIS_ESFORCO.forEach(function(n) { porNivel[n] = []; });
      historico.forEach(function(c) {
        if (!c.concludedAt) return;                             // só quem atravessou o fluxo
        var tp = temposDoCard(c);
        if (tp.ativoH > 0) {
          global.push(tp.ativoH);
          if (c.nivelEsforco && porNivel[c.nivelEsforco]) porNivel[c.nivelEsforco].push(tp.ativoH);
        }
        Object.keys(tp.porEtapa).forEach(function(e) {
          if (tp.porEtapa[e] <= 0) return;
          (amostrasEtapa[e] = amostrasEtapa[e] || []).push(tp.porEtapa[e]);
        });
      });
      function stat(arr) {
        return {
          n: arr.length, med: median(arr), avg: mean(arr),               // ◀ helpers EXISTENTES
          min: arr.length ? round1(Math.min.apply(null, arr)) : 0,
          max: arr.length ? round1(Math.max.apply(null, arr)) : 0
        };
      }
      var nivel = {}; NIVEIS_ESFORCO.forEach(function(n) { nivel[n] = stat(porNivel[n]); });
      var etapa = {}; Object.keys(amostrasEtapa).forEach(function(e) { etapa[e] = stat(amostrasEtapa[e]); });
      return { nivel: nivel, etapa: etapa, global: stat(global), totalConcluidos: global.length };
    }
    // Memo por load: invalida quando cachedData é substituído (loadRealtime cria objeto novo).
    function obterBase(historico) {
      if (_baseCache && _baseCache.ref === cachedData) return _baseCache.base;
      var base = calcularBase(historico);
      _baseCache = { ref: cachedData, base: base };
      return base;
    }

    // ══════════════ 5. DURAÇÃO (cascata explícita) ══════════════
    // Devolve { horas, base:'REAL'|'ESTIMADO', origem, n, semDado }.
    // A ORIGEM viaja até o Notes da tarefa e até a planilha de auditoria: nenhuma
    // estimativa chega ao Project sem dizer de onde veio.
    function calcularDuracao(c, tp, base, config) {
      // 1) dado REAL do próprio card (quando a fonte escolhida permite)
      if (cfg.fonte === 'esforco' && c.concludedAt && tp.ativoH >= 0.1) {
        return { horas: tp.ativoH, base: 'REAL', n: 1,
                 origem: 'Esforço ativo real do card (' + nf(tp.ativoH) + 'h úteis)' };
      }
      if (cfg.fonte === 'bruto' && c.leadTimeReal !== null && c.leadTimeReal !== undefined && c.leadTimeReal > 0) {
        return { horas: c.leadTimeReal * HORAS_DIA, base: 'REAL', n: 1,
                 origem: 'Lead time real do card (' + c.leadTimeReal + ' d.u., bruto)' };
      }
      // 2) cascata histórica: nível → etapa → global → SLA
      var nivel = c.nivelEsforco;
      if (nivel && base.nivel[nivel] && base.nivel[nivel].n >= MIN_AMOSTRA && base.nivel[nivel].med > 0) {
        return { horas: base.nivel[nivel].med, base: 'ESTIMADO', n: base.nivel[nivel].n,
                 origem: 'Mediana do nível ' + nivel + ' (n=' + base.nivel[nivel].n + ')' };
      }
      var etapa = (c.currentListName || '').trim();
      if (base.etapa[etapa] && base.etapa[etapa].n >= MIN_AMOSTRA && base.etapa[etapa].med > 0) {
        return { horas: base.etapa[etapa].med, base: 'ESTIMADO', n: base.etapa[etapa].n,
                 origem: 'Mediana da etapa "' + etapa + '" (n=' + base.etapa[etapa].n + ')' };
      }
      if (base.global.n >= 1 && base.global.med > 0) {
        return { horas: base.global.med, base: 'ESTIMADO', n: base.global.n,
                 origem: 'Mediana global do board (n=' + base.global.n + ')' };
      }
      var sla = (config.sla || DEFAULT_SLA)[etapa];
      if (sla && sla > 0 && sla < 999) {
        return { horas: sla * HORAS_DIA, base: 'ESTIMADO', n: 0,
                 origem: 'SLA configurado da etapa (' + sla + ' d.u.) — sem histórico' };
      }
      return { horas: HORAS_DIA, base: 'ESTIMADO', n: 0, semDado: true,
               origem: 'SEM DADO: 1 dia útil assumido' };
    }

    // ══════════════ 6. ATIVIDADES (card → tarefa) ══════════════
    function montarAtividades(config) {
      var abertos = (cachedData && cachedData.cards) ? cachedData.cards : [];
      var arquivados = (cachedData && cachedData.archived) ? cachedData.archived : [];
      var base = obterBase(abertos.concat(arquivados));   // arquivados = SÓ base histórica
      var pessoas = construirPessoas(cfg.pessoas);
      var marcasPrio = construirMarcas(cfg.etiquetasPrioridadeNegocio);
      var out = [];

      abertos.forEach(function(c) {
        if (!cfg.incluirConcluidos && c.isConcluido) return;

        var tp = temposDoCard(c);
        var dur = calcularDuracao(c, tp, base, config);
        var etapa = (c.currentListName || '').trim();
        var problemas = [];

        // ── Recursos e cliente a partir das etiquetas (ETAPA 4) ──
        // Ordem de classificação: pessoa → marca de prioridade → cliente → outras.
        // As marcas de prioridade saem ANTES da escolha do cliente; sem isso, uma
        // etiqueta 'VIP' seria adotada como nome do cliente e o cliente real cairia
        // em outrasEtiquetas, deslocando a hierarquia inteira do board.
        var recursos = [], outrasEtiquetas = [], etiquetasPrio = [], cliente = null;
        (c.labels || []).forEach(function(l) {
          var nomeL = String(l === null || l === undefined ? '' : l).trim();
          if (!nomeL) return;
          var p = pessoaDaEtiqueta(nomeL, pessoas);
          if (p) { if (recursos.indexOf(p) === -1) recursos.push(p); return; }
          if (ehEtiquetaPrioridade(nomeL, marcasPrio)) { etiquetasPrio.push(nomeL); return; }
          if (cliente === null) cliente = nomeL;                // 1ª não-pessoa = Cliente
          else outrasEtiquetas.push(nomeL);
        });
        var viaMembro = false;
        if (!recursos.length && (c.members || []).length) {      // fallback: membro do card
          recursos = c.members.slice();
          viaMembro = true;
        }
        if (!recursos.length) problemas.push('semRecurso');
        if (cliente === null) problemas.push('semCliente');
        if (FLOW_LISTS.indexOf(etapa) === -1) problemas.push('semEtapa');

        // ── Datas reais ──
        var inicioReal = tp.inicio || tp.primeiroAtivo || null;
        var conclusao = c.concludedAt ? new Date(c.concludedAt) : null;
        var actualStart = null, actualFinish = null;
        if (conclusao) {
          actualStart = inicioReal || (c.createdAt ? new Date(c.createdAt) : null);
          actualFinish = conclusao;
          if (!actualStart || !(actualFinish > actualStart)) {   // data final ≤ inicial
            problemas.push('datasInvalidas');
            actualStart = null; actualFinish = null;             // descarta e reagenda
          }
        } else if (inicioReal) {
          actualStart = inicioReal;                              // em andamento: só o início é real
        }

        // ── Duração final: concluído com datas reais preservadas usa o período real ──
        // (o esforço ativo não se perde: vai em campo auxiliar + Notes)
        var durH = dur.horas, estimado = (dur.base === 'ESTIMADO');
        if (actualFinish && cfg.preservarDatasReais) {
          durH = round1(businessHoursRaw(actualStart, actualFinish));  // ◀ motor EXISTENTE
          estimado = false;
        }
        if (!(durH > 0)) { durH = 0.5; problemas.push('duracaoInvalida'); }
        if (dur.semDado) problemas.push('semDuracao');

        var nome = (c.name || '').trim();
        if (!nome) { problemas.push('semNome'); nome = '(sem título) ' + String(c.id || '').slice(-6); }

        var pct = c.isConcluido || conclusao ? 100 : (PCT_ETAPA[etapa] === undefined ? 0 : PCT_ETAPA[etapa]);

        // Esforço/Urgência (Number1): informativo. Era o valor de Priority até o item 3.
        var esforcoUrgencia = Math.min(1000, (PRIO_NIVEL[c.nivelEsforco] || PRIO_PADRAO) + (c.isLate ? 100 : 0));
        // Priority (governa o nivelamento automático do Project): vem do negócio.
        // Sem etiqueta de prioridade configurada, cai no Esforço/Urgência — idêntico ao anterior.
        var prio = etiquetasPrio.length ? PRIO_NEGOCIO : esforcoUrgencia;

        out.push({
          card: c, nome: nome, cliente: cliente === null ? 'Sem cliente' : cliente, etapa: etapa,
          recursos: recursos, viaMembro: viaMembro, outrasEtiquetas: outrasEtiquetas,
          etiquetasPrio: etiquetasPrio, esforcoUrgencia: esforcoUrgencia,
          durH: durH, durBase: estimado ? 'ESTIMADO' : 'REAL', durOrigem: dur.origem,
          estimado: estimado, esforcoAtivoH: tp.ativoH, filaH: tp.filaH, externaH: tp.externaH,
          porEtapa: tp.porEtapa, actualStart: actualStart, actualFinish: actualFinish,
          pct: pct, prio: prio,
          deadline: c.due ? new Date(c.due) : null,
          problemas: problemas,
          bloqueado: problemas.indexOf('semNome') !== -1 || problemas.indexOf('duracaoInvalida') !== -1,
          temAviso: problemas.filter(function(p) { return p !== 'semCliente'; }).length > 0
        });
      });
      return { atividades: out, base: base };
    }

    // ══════════════ 7. HIERARQUIA + PREDECESSORAS + AGENDA ══════════════
    // Projeto (1) > Cliente (2) > Etapa (3) > Atividade (4).
    // Predecessoras: as tarefas-resumo de ETAPA de um mesmo cliente encadeiam FS na
    // ordem canônica de FLOW_LISTS. Atividades dentro da mesma etapa ficam em
    // PARALELO. Como a ordem é canônica e cada corrente é local ao cliente, ciclo é
    // estruturalmente impossível (validado depois: pred.uid < uid sempre).
    function montarEstrutura(atividades, projNome, fer) {
      var porCliente = {}, ordem = [];
      atividades.forEach(function(a) {
        if (!porCliente[a.cliente]) { porCliente[a.cliente] = { etapas: {}, total: 0 }; ordem.push(a.cliente); }
        var g = porCliente[a.cliente];
        (g.etapas[a.etapa] = g.etapas[a.etapa] || []).push(a);
        g.total++;
      });
      ordem.sort(function(a, b) {
        if (a === 'Sem cliente') return 1;
        if (b === 'Sem cliente') return -1;
        return porCliente[b].total - porCliente[a].total || a.localeCompare(b);
      });

      // Início do projeto = data real mais antiga encontrada (senão, hoje).
      var projStart = null;
      atividades.forEach(function(a) {
        if (a.actualStart && (!projStart || a.actualStart < projStart)) projStart = a.actualStart;
      });
      if (!projStart) projStart = proximoInicioUtil(new Date(), fer);

      var tasks = [], uid = 0;
      function push(o) { o.uid = ++uid; o.id = uid; tasks.push(o); return o; }

      var root = push({ nome: projNome, level: 1, summary: true });
      var minRoot = null, maxRoot = null;

      ordem.forEach(function(cli) {
        var cliTask = push({ nome: cli, level: 2, summary: true });
        var minCli = null, maxCli = null;

        // etapas na ordem canônica do fluxo; qualquer etapa fora dela vai ao fim
        var etapas = FLOW_LISTS.filter(function(e) { return porCliente[cli].etapas[e]; });
        Object.keys(porCliente[cli].etapas).forEach(function(e) {
          if (etapas.indexOf(e) === -1) etapas.push(e);
        });

        var cursor = new Date(projStart);
        var predAnterior = null;

        etapas.forEach(function(etp) {
          var etTask = push({ nome: etp || '(sem etapa)', level: 3, summary: true, pred: predAnterior });
          var inicioGrupo = proximoInicioUtil(cursor, fer);
          var minEt = null, maxEt = null;

          porCliente[cli].etapas[etp].forEach(function(a) {
            var st, fi;
            if (a.actualStart) {
              st = a.actualStart;
              fi = a.actualFinish ? a.actualFinish : somarHorasUteis(st, a.durH, fer);
            } else {
              st = inicioGrupo;                                   // paralelo dentro da etapa
              fi = somarHorasUteis(st, a.durH, fer);
            }
            var t = push({ nome: a.nome, level: 4, summary: false, ativ: a, start: st, finish: fi });
            a.task = t;
            if (!minEt || st < minEt) minEt = st;
            if (!maxEt || fi > maxEt) maxEt = fi;
          });

          etTask.start = minEt || inicioGrupo;
          etTask.finish = maxEt || inicioGrupo;
          cursor = new Date(etTask.finish);                        // próxima etapa espera esta
          predAnterior = etTask.uid;
          if (!minCli || etTask.start < minCli) minCli = etTask.start;
          if (!maxCli || etTask.finish > maxCli) maxCli = etTask.finish;
        });

        cliTask.start = minCli || projStart;
        cliTask.finish = maxCli || projStart;
        if (!minRoot || cliTask.start < minRoot) minRoot = cliTask.start;
        if (!maxRoot || cliTask.finish > maxRoot) maxRoot = cliTask.finish;
      });

      root.start = minRoot || projStart;
      root.finish = maxRoot || projStart;
      return { tasks: tasks, projStart: root.start, projFinish: root.finish };
    }

    // ══════════════ 8. RECURSOS E ATRIBUIÇÕES ══════════════
    // Cada pessoa distinta vira UM Resource (Type=1, trabalho). Card com 2 pessoas
    // gera 2 atribuições a 100% cada — duração igual, trabalho total dobrado.
    function montarRecursos(tasks) {
      var mapa = {}, recursos = [], assigns = [], auid = 0;
      tasks.forEach(function(t) {
        if (t.summary || !t.ativ) return;
        t.ativ.recursos.forEach(function(nome) {
          if (!mapa[nome]) {
            mapa[nome] = recursos.length + 1;
            recursos.push({ uid: mapa[nome], nome: nome });
          }
          assigns.push({ uid: ++auid, taskUid: t.uid, resUid: mapa[nome], pct: t.ativ.pct });
        });
      });
      return { recursos: recursos, assigns: assigns };
    }

    // ══════════════ 9. VALIDAÇÃO ══════════════
    var ROTULO_PROBLEMA = {
      semNome:         { sev: 'bloq',  texto: 'Atividade sem nome' },
      duracaoInvalida: { sev: 'bloq',  texto: 'Duração inválida (≤ 0)' },
      datasInvalidas:  { sev: 'aviso', texto: 'Data final anterior à inicial — datas reais descartadas' },
      semDuracao:      { sev: 'aviso', texto: 'Sem histórico para estimar duração (1 dia assumido)' },
      semRecurso:      { sev: 'aviso', texto: 'Nenhum recurso reconhecido (etiqueta nem membro)' },
      semEtapa:        { sev: 'aviso', texto: 'Etapa fora das listas do fluxo' },
      semCliente:      { sev: 'info',  texto: 'Sem etiqueta de cliente (agrupado em "Sem cliente")' }
    };
    function validar(atividades, tasks) {
      var contagem = {}, cards = {};
      Object.keys(ROTULO_PROBLEMA).forEach(function(k) { contagem[k] = 0; cards[k] = []; });
      atividades.forEach(function(a) {
        a.problemas.forEach(function(p) {
          if (contagem[p] === undefined) return;
          contagem[p]++; cards[p].push(a.card);
        });
      });
      // Sanidade estrutural: predecessora tem de existir e ser anterior (sem ciclo).
      var ciclos = 0, byUid = {};
      tasks.forEach(function(t) { byUid[t.uid] = t; });
      tasks.forEach(function(t) { if (t.pred && (!byUid[t.pred] || t.pred >= t.uid)) ciclos++; });
      return {
        total: atividades.length,
        bloqueadas: atividades.filter(function(a) { return a.bloqueado; }).length,
        comAviso: atividades.filter(function(a) { return a.temAviso && !a.bloqueado; }).length,
        prontas: atividades.filter(function(a) { return !a.bloqueado && !a.temAviso; }).length,
        contagem: contagem, cards: cards, ciclos: ciclos
      };
    }

    // ══════════════ 10. CONSTRUÇÃO DO PACOTE ══════════════
    function construir() {
      // Default preguiçoso: construir() nunca depende de a UI ter carregado a config
      // antes (render() carrega, mas qualquer outro chamador fica seguro do mesmo jeito).
      if (!cfg) cfg = normalizarCfg(null);
      var config = (cachedData && cachedData.config) ? cachedData.config : DEFAULTS;
      var m = montarAtividades(config);
      var todas = m.atividades;

      // Bloqueios NUNCA entram (cronograma inválido); avisos entram salvo opção contrária.
      var exportaveis = todas.filter(function(a) {
        if (a.bloqueado) return false;
        if (cfg.excluirComAviso && a.temAviso) return false;
        return true;
      });

      var anoIni = new Date().getFullYear(), anoFim = anoIni + 3;
      todas.forEach(function(a) {
        if (a.actualStart) anoIni = Math.min(anoIni, a.actualStart.getFullYear());
      });
      var fer = montarFeriados(anoIni - 1, anoFim);

      var projNome = boardNome || 'Produção Midiática';
      var est = montarEstrutura(exportaveis, projNome, fer);
      var rec = montarRecursos(est.tasks);
      var val = validar(todas, est.tasks);

      var hoje = new Date();
      var fileBase = 'cronograma_msproject_' + String(hoje.getDate()).padStart(2, '0') + '-' +
        String(hoje.getMonth() + 1).padStart(2, '0') + '-' + hoje.getFullYear();

      ultimoPacote = {
        atividades: todas, exportaveis: exportaveis, tasks: est.tasks,
        projStart: est.projStart, projFinish: est.projFinish, projNome: projNome,
        recursos: rec.recursos, assigns: rec.assigns, base: m.base, feriados: fer,
        validacao: val, fileBase: fileBase
      };
      return ultimoPacote;
    }

    // ══════════════ 11. HELPERS DE APRESENTAÇÃO DOS DADOS ══════════════
    function statusDe(a) {
      var c = a.card;
      if (c.isConcluido || c.concludedAt) return 'Concluído';
      if (c.isLate) return 'Atrasado';
      if (a.actualStart) return 'Em andamento';
      return 'Não iniciado';
    }
    function breakdownStr(a) {
      var partes = [];
      FLOW_LISTS.forEach(function(e) { if (a.porEtapa[e] > 0) partes.push(e + ' ' + nf(a.porEtapa[e]) + 'h'); });
      Object.keys(a.porEtapa).forEach(function(e) {
        if (FLOW_LISTS.indexOf(e) === -1 && a.porEtapa[e] > 0) partes.push(e + ' ' + nf(a.porEtapa[e]) + 'h');
      });
      return partes.join(' · ');
    }
    function notasDe(a) {
      var c = a.card;
      var l = [];
      l.push('DURAÇÃO — base: ' + a.durBase + (a.estimado ? ' (estimativa)' : ' (dado real)'));
      l.push('Origem: ' + a.durOrigem);
      l.push('Valor aplicado: ' + nf(a.durH) + 'h úteis = ' + nf(h2d(a.durH)) + ' d.u.');
      l.push('');
      l.push('TEMPOS MEDIDOS (motor do Power-Up, jornada 09–18h)');
      l.push('· Esforço ativo: ' + nf(a.esforcoAtivoH) + 'h (' + nf(h2d(a.esforcoAtivoH)) + ' d.u.)');
      l.push('· Tempo em fila interna: ' + nf(a.filaH) + 'h');
      l.push('· Espera externa (cliente): ' + nf(a.externaH) + 'h');
      if (c.leadTimeReal !== null && c.leadTimeReal !== undefined) l.push('· Lead time bruto (KPI6): ' + c.leadTimeReal + ' d.u.');
      if (c.primeiraEntrega) {
        l.push('· Tempo até 1ª entrega: ' + nf(c.primeiraEntrega.horas) + 'h (' + c.primeiraEntrega.dias + ' d.u.)');
        l.push('· Reentradas em "Em andamento": ' + c.primeiraEntrega.entradasEmAndamento);
      }
      var bd = breakdownStr(a);
      if (bd) l.push('· Por etapa: ' + bd);
      l.push('');
      l.push('CONTEXTO');
      l.push('· Etapa atual: ' + (a.etapa || '—'));
      l.push('· Cliente: ' + a.cliente);
      l.push('· Nível de Esforço: ' + (c.nivelEsforco || 'não definido'));
      l.push('· Esforço/Urgência (Number1, informativo): ' + a.esforcoUrgencia);
      l.push('· Priority (governa o nivelamento): ' + a.prio +
        (a.etiquetasPrio.length ? ' — prioridade de negócio: ' + a.etiquetasPrio.join(', ') : ' — sem etiqueta de negócio (= Esforço/Urgência)'));
      l.push('· Status: ' + statusDe(a));
      l.push('· Retrabalhos (campo do Trello): ' + (c.retrabalho || 0));
      l.push('· Recursos: ' + (a.recursos.length ? a.recursos.join(', ') + (a.viaMembro ? ' (via membro do card)' : ' (via etiqueta)') : 'nenhum reconhecido'));
      if (a.outrasEtiquetas.length) l.push('· Outras etiquetas: ' + a.outrasEtiquetas.join(', '));
      if (a.problemas.length) l.push('· Avisos da validação: ' + a.problemas.map(function(p) { return (ROTULO_PROBLEMA[p] || {}).texto || p; }).join(' | '));
      l.push('');
      l.push('Card: ' + (c.url || c.id));
      return l.join('\n');
    }

    // ══════════════ 12. XML MSPDI ══════════════
    // A ORDEM dos elementos importa: o schema MSPDI é uma <sequence>. A ordem abaixo
    // segue a do XSD da Microsoft — trocar de lugar faz o Project recusar o arquivo.
    function esc(s) {
      return String(s === null || s === undefined ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');   // controles inválidos em XML 1.0
    }
    function xdate(d) {
      d = new Date(d);
      function p(n) { return String(n).padStart(2, '0'); }
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
        'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }
    function isoDur(horas) {
      var min = Math.max(0, Math.round(horas * 60));
      return 'PT' + Math.floor(min / 60) + 'H' + (min % 60) + 'M0S';
    }
    function hhmm(h) { return String(h).padStart(2, '0') + ':00:00'; }

    function xmlCalendario(fer) {
      var s = '<Calendars><Calendar><UID>1</UID><Name>Padrão Midiática</Name>' +
        '<IsBaseCalendar>1</IsBaseCalendar><BaseCalendarUID>-1</BaseCalendarUID><WeekDays>';
      // DayType: 1=domingo … 7=sábado
      for (var dt = 1; dt <= 7; dt++) {
        var util = (dt >= 2 && dt <= 6);
        s += '<WeekDay><DayType>' + dt + '</DayType><DayWorking>' + (util ? 1 : 0) + '</DayWorking>';
        if (util) {
          s += '<WorkingTimes><WorkingTime><FromTime>' + hhmm(WORK_START_HOUR) +
               '</FromTime><ToTime>' + hhmm(WORK_END_HOUR) + '</ToTime></WorkingTime></WorkingTimes>';
        }
        s += '</WeekDay>';
      }
      // Feriados como exceção de calendário (DayType 0 + TimePeriod): o Project
      // reagenda sozinho o que cair nesses dias. Os KPIs seguem sem feriados.
      fer.lista.forEach(function(f) {
        var ini = new Date(f.d); ini.setHours(0, 0, 0, 0);
        var fim = new Date(f.d); fim.setHours(23, 59, 0, 0);
        s += '<WeekDay><DayType>0</DayType><DayWorking>0</DayWorking><TimePeriod><FromDate>' +
          xdate(ini) + '</FromDate><ToDate>' + xdate(fim) + '</ToDate></TimePeriod></WeekDay>';
      });
      return s + '</WeekDays></Calendar></Calendars>';
    }

    function xmlExtDefs() {
      var s = '<ExtendedAttributes>';
      EXT.concat([EXT_NUM]).forEach(function(e) {
        s += '<ExtendedAttribute><FieldID>' + e.fid + '</FieldID><FieldName>' + e.nome +
          '</FieldName><Alias>' + esc(e.alias) + '</Alias></ExtendedAttribute>';
      });
      return s + '</ExtendedAttributes>';
    }

    function xmlTarefa(t, wbs) {
      var a = t.ativ;
      var s = '<Task>';
      s += '<UID>' + t.uid + '</UID><ID>' + t.id + '</ID><Name>' + esc(t.nome) + '</Name>';
      s += '<Active>1</Active><Manual>0</Manual>';
      s += '<Type>' + (t.summary ? 1 : 0) + '</Type><IsNull>0</IsNull>';
      s += '<WBS>' + esc(wbs) + '</WBS><OutlineNumber>' + esc(wbs) + '</OutlineNumber>';
      s += '<OutlineLevel>' + t.level + '</OutlineLevel>';
      s += '<Priority>' + (a ? a.prio : PRIO_PADRAO) + '</Priority>';
      if (t.start) s += '<Start>' + xdate(t.start) + '</Start>';
      if (t.finish) s += '<Finish>' + xdate(t.finish) + '</Finish>';
      if (!t.summary && a) {
        // DurationFormat 7 = dias · 39 = dias ESTIMADOS (o Project mostra "5d?").
        // É a marcação nativa de estimativa — estimativa nunca se disfarça de dado real.
        s += '<Duration>' + isoDur(a.durH) + '</Duration>';
        s += '<DurationFormat>' + (a.estimado ? 39 : 7) + '</DurationFormat>';
        s += '<Estimated>' + (a.estimado ? 1 : 0) + '</Estimated>';
      }
      s += '<Milestone>0</Milestone><Summary>' + (t.summary ? 1 : 0) + '</Summary>';
      if (!t.summary && a) {
        s += '<PercentComplete>' + a.pct + '</PercentComplete>';
        if (a.actualStart) s += '<ActualStart>' + xdate(a.actualStart) + '</ActualStart>';
        if (a.actualFinish) s += '<ActualFinish>' + xdate(a.actualFinish) + '</ActualFinish>';
      }
      s += '<ConstraintType>0</ConstraintType>';                  // As Soon As Possible
      if (!t.summary && a && a.deadline) s += '<Deadline>' + xdate(a.deadline) + '</Deadline>';
      if (!t.summary && a && a.card.url) {
        s += '<Hyperlink>Abrir no Trello</Hyperlink><HyperlinkAddress>' + esc(a.card.url) + '</HyperlinkAddress>';
      }
      if (!t.summary && a) s += '<Notes>' + esc(notasDe(a)) + '</Notes>';
      if (t.pred) {
        s += '<PredecessorLink><PredecessorUID>' + t.pred +
          '</PredecessorUID><Type>1</Type><CrossProject>0</CrossProject><LinkLag>0</LinkLag><LagFormat>7</LagFormat></PredecessorLink>';
      }
      if (!t.summary && a) {
        var c = a.card;
        var vals = [
          c.id || '', c.url || '', a.etapa || '', a.cliente,
          c.nivelEsforco || '', statusDe(a),
          (c.leadTimeReal === null || c.leadTimeReal === undefined) ? '' : String(c.leadTimeReal),
          c.primeiraEntrega ? nf(c.primeiraEntrega.horas) : '',
          nf(a.filaH), breakdownStr(a)
        ];
        EXT.forEach(function(e, i) {
          if (vals[i] === '' || vals[i] === null || vals[i] === undefined) return;
          s += '<ExtendedAttribute><FieldID>' + e.fid + '</FieldID><Value>' + esc(vals[i]) + '</Value></ExtendedAttribute>';
        });
        // Number1: escala de esforço/urgência — informativa, fora do nivelamento.
        s += '<ExtendedAttribute><FieldID>' + EXT_NUM.fid + '</FieldID><Value>' + a.esforcoUrgencia + '</Value></ExtendedAttribute>';
      }
      return s + '</Task>';
    }

    function gerarXML(p) {
      // WBS/OutlineNumber hierárquico (1, 1.1, 1.1.1, …) — o Project usa para a estrutura.
      var contadores = [0, 0, 0, 0, 0];
      function wbsDe(level) {
        contadores[level - 1]++;
        for (var i = level; i < contadores.length; i++) contadores[i] = 0;
        return contadores.slice(0, level).join('.');
      }

      var s = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
      s += '<Project xmlns="http://schemas.microsoft.com/project">';
      s += '<SaveVersion>14</SaveVersion>';
      s += '<Name>' + esc(p.fileBase + '.xml') + '</Name>';
      s += '<Title>' + esc(p.projNome) + '</Title>';
      s += '<CreationDate>' + xdate(new Date()) + '</CreationDate>';
      s += '<ScheduleFromStart>1</ScheduleFromStart>';
      s += '<StartDate>' + xdate(p.projStart) + '</StartDate>';
      s += '<FinishDate>' + xdate(p.projFinish) + '</FinishDate>';
      s += '<CurrencyDigits>2</CurrencyDigits><CurrencySymbol>R$</CurrencySymbol><CurrencySymbolPosition>0</CurrencySymbolPosition>';
      s += '<CalendarUID>1</CalendarUID>';
      s += '<DefaultStartTime>' + hhmm(WORK_START_HOUR) + '</DefaultStartTime>';
      s += '<DefaultFinishTime>' + hhmm(WORK_END_HOUR) + '</DefaultFinishTime>';
      // Jornada declarada ao Project = a MESMA de businessHoursRaw (9h/dia, 45h/semana).
      s += '<MinutesPerDay>' + (HORAS_DIA * 60) + '</MinutesPerDay>';
      s += '<MinutesPerWeek>' + (HORAS_DIA * 5 * 60) + '</MinutesPerWeek>';
      s += '<DaysPerMonth>20</DaysPerMonth>';
      s += '<DefaultTaskType>0</DefaultTaskType>';
      s += '<DurationFormat>7</DurationFormat><WorkFormat>2</WorkFormat>';
      s += '<NewTasksAreManual>0</NewTasksAreManual>';
      s += '<WeekStartDay>1</WeekStartDay>';
      s += xmlExtDefs();
      s += xmlCalendario(p.feriados);

      s += '<Tasks>';
      p.tasks.forEach(function(t) { s += xmlTarefa(t, wbsDe(t.level)); });
      s += '</Tasks>';

      s += '<Resources>';
      p.recursos.forEach(function(r) {
        s += '<Resource><UID>' + r.uid + '</UID><ID>' + r.uid + '</ID><Name>' + esc(r.nome) +
          '</Name><Type>1</Type><IsNull>0</IsNull><MaxUnits>1</MaxUnits><CalendarUID>1</CalendarUID></Resource>';
      });
      s += '</Resources>';

      // Units=1 (100% cada) e SEM <Work> explícito: o Project calcula
      // Work = Duration × Units. Card com 2 pessoas → 2 atribuições → trabalho dobrado,
      // duração inalterada, que é a regra escolhida.
      s += '<Assignments>';
      p.assigns.forEach(function(g) {
        s += '<Assignment><UID>' + g.uid + '</UID><TaskUID>' + g.taskUid + '</TaskUID><ResourceUID>' +
          g.resUid + '</ResourceUID><PercentWorkComplete>' + g.pct + '</PercentWorkComplete><Units>1</Units></Assignment>';
      });
      s += '</Assignments>';

      return s + '</Project>';
    }

    // ══════════════ 13. PLANILHA DE AUDITORIA (XLSX, fallback CSV) ══════════════
    var COLS_CRONO = ['ID','Outline Level','Task Name','Summary','Start','Finish','Duration (d.u.)',
      'Duration (h úteis)','Base','Origem da duração','Predecessors','Resource Names','% Complete',
      'Priority (negócio)','Esforço/Urgência','Etiquetas de prioridade',
      'Client','Stage','Difficulty','Status','Lead Time bruto (d.u.)','1ª entrega (h)',
      'Tempo em fila (h)','Espera externa (h)','Tempo por etapa (h)','Deadline','Trello Card ID','Trello Card URL'];

    function linhasCronograma(p) {
      return p.tasks.map(function(t) {
        var a = t.ativ, c = a ? a.card : null;
        return [
          t.id, t.level, t.nome, t.summary ? 'Sim' : 'Não',
          t.start ? fmtDateTime(t.start) : '', t.finish ? fmtDateTime(t.finish) : '',
          a ? h2d(a.durH) : '', a ? round1(a.durH) : '',
          a ? a.durBase : '', a ? a.durOrigem : '',
          t.pred ? String(t.pred) : '',
          a ? a.recursos.join(';') : '',
          a ? a.pct : '', a ? a.prio : '',
          a ? a.esforcoUrgencia : '', a ? a.etiquetasPrio.join(';') : '',
          a ? a.cliente : '', a ? a.etapa : '',
          a && c.nivelEsforco ? c.nivelEsforco : '',
          a ? statusDe(a) : '',
          a && c.leadTimeReal !== null && c.leadTimeReal !== undefined ? c.leadTimeReal : '',
          a && c.primeiraEntrega ? round1(c.primeiraEntrega.horas) : '',
          a ? round1(a.filaH) : '', a ? round1(a.externaH) : '',
          a ? breakdownStr(a) : '',
          a && a.deadline ? fmtDateTime(a.deadline) : '',
          a ? c.id : '', a ? (c.url || '') : ''
        ];
      });
    }
    function linhasBase(p) {
      var rows = [['Mediana por Nível de Esforço (esforço ativo até a conclusão)']];
      rows.push(['Nível','Amostras (n)','Mediana (h úteis)','Mediana (d.u.)','Média (h)','Mín (h)','Máx (h)']);
      NIVEIS_ESFORCO.forEach(function(n) {
        var s = p.base.nivel[n];
        rows.push([n, s.n, s.med, h2d(s.med), s.avg, s.min, s.max]);
      });
      rows.push([]);
      rows.push(['Mediana por Etapa (tempo típico de permanência)']);
      rows.push(['Etapa','Amostras (n)','Mediana (h úteis)','Mediana (d.u.)','Média (h)','Mín (h)','Máx (h)']);
      FLOW_LISTS.forEach(function(e) {
        var s = p.base.etapa[e];
        if (!s) return;
        rows.push([e, s.n, s.med, h2d(s.med), s.avg, s.min, s.max]);
      });
      rows.push([]);
      rows.push(['Global', p.base.global.n, p.base.global.med, h2d(p.base.global.med), p.base.global.avg, p.base.global.min, p.base.global.max]);
      return rows;
    }
    function linhasValidacao(p) {
      var v = p.validacao;
      var rows = [['Resumo da validação']];
      rows.push(['Métrica','Quantidade']);
      rows.push(['Atividades analisadas', v.total]);
      rows.push(['Prontas (sem ressalva)', v.prontas]);
      rows.push(['Com aviso', v.comAviso]);
      rows.push(['Bloqueadas (excluídas)', v.bloqueadas]);
      rows.push(['Exportadas', p.exportaveis.length]);
      rows.push(['Predecessoras inconsistentes / ciclos', v.ciclos]);
      rows.push([]);
      rows.push(['Ocorrências por problema']);
      rows.push(['Severidade','Problema','Qtde','Cards']);
      Object.keys(ROTULO_PROBLEMA).forEach(function(k) {
        if (!v.contagem[k]) return;
        var r = ROTULO_PROBLEMA[k];
        rows.push([r.sev === 'bloq' ? 'BLOQUEIO' : (r.sev === 'aviso' ? 'AVISO' : 'INFO'),
          r.texto, v.contagem[k], v.cards[k].map(function(c) { return c.name; }).join(' | ')]);
      });
      return rows;
    }

    function gerarXLSX(p, btn, status) {
      setBtnLoading(btn, true);
      function fim(msg) { setBtnLoading(btn, false); if (status) status.textContent = msg; }
      loadXLSXLib(function(err) {
        if (err || typeof XLSX === 'undefined') { gerarCSV(p); fim('XLSX indisponível — exportado CSV.'); return; }
        try {
          var XB = { top:{style:'thin',color:{rgb:'DDDDDD'}}, bottom:{style:'thin',color:{rgb:'DDDDDD'}},
                     left:{style:'thin',color:{rgb:'DDDDDD'}}, right:{style:'thin',color:{rgb:'DDDDDD'}} };
          var stHead = {font:{bold:true,color:{rgb:'FFFFFF'},sz:11},fill:{fgColor:{rgb:'0A0A0A'}},border:XB,
                        alignment:{horizontal:'center',vertical:'center',wrapText:true}};
          function stData(i, sumario) {
            return { fill:{fgColor:{rgb: sumario ? 'FFF4CC' : (i % 2 === 0 ? 'FFFFFF' : 'F7F8F9')}},
                     border:XB, alignment:{vertical:'center'}, font: sumario ? {bold:true} : undefined };
          }
          function aplicar(ws, aoa, headerRow, sumarioDe) {
            for (var r = 0; r < aoa.length; r++) {
              for (var c = 0; c < aoa[r].length; c++) {
                var ref = XLSX.utils.encode_cell({ r: r, c: c });
                if (!ws[ref]) ws[ref] = { t: 's', v: '' };
                ws[ref].s = (r === headerRow) ? stHead : stData(r, sumarioDe ? sumarioDe(r) : false);
              }
            }
          }
          function largura(aoa, max) {
            var w = [];
            for (var c = 0; c < (aoa[0] || []).length; c++) {
              var m = 8;
              for (var r = 0; r < aoa.length; r++) {
                var v = aoa[r][c];
                if (v !== null && v !== undefined) m = Math.max(m, Math.min(max, String(v).length + 2));
              }
              w.push({ wch: m });
            }
            return w;
          }

          var wb = XLSX.utils.book_new();

          var crono = [COLS_CRONO].concat(linhasCronograma(p));
          var ws1 = XLSX.utils.aoa_to_sheet(crono);
          ws1['!cols'] = largura(crono, 46);
          ws1['!autofilter'] = { ref: 'A1:' + XLSX.utils.encode_cell({ r: crono.length - 1, c: COLS_CRONO.length - 1 }) };
          aplicar(ws1, crono, 0, function(r) { return r > 0 && crono[r][3] === 'Sim'; });
          XLSX.utils.book_append_sheet(wb, ws1, 'Cronograma');

          var bs = linhasBase(p);
          var maxB = 7; bs.forEach(function(r) { while (r.length < maxB) r.push(''); });
          var ws2 = XLSX.utils.aoa_to_sheet(bs);
          ws2['!cols'] = largura(bs, 30);
          aplicar(ws2, bs, 1);
          XLSX.utils.book_append_sheet(wb, ws2, 'Base histórica');

          var vs = linhasValidacao(p);
          var maxV = 4; vs.forEach(function(r) { while (r.length < maxV) r.push(''); });
          var ws3 = XLSX.utils.aoa_to_sheet(vs);
          ws3['!cols'] = [{wch:14},{wch:52},{wch:10},{wch:80}];
          aplicar(ws3, vs, 1);
          XLSX.utils.book_append_sheet(wb, ws3, 'Validação');

          XLSX.writeFile(wb, p.fileBase + '.xlsx');
          fim('Planilha de auditoria gerada.');
        } catch (e) {
          console.warn('[MSP] Falha no XLSX:', e && e.message ? e.message : String(e));
          gerarCSV(p);
          fim('Falha no XLSX — exportado CSV.');
        }
      });
    }
    function gerarCSV(p) {
      downloadCSV(p.fileBase + '.csv', [COLS_CRONO].concat(linhasCronograma(p)));
    }
    function exportarXML(p, btn, status) {
      setBtnLoading(btn, true);
      try {
        var xml = gerarXML(p);
        triggerDownload(new Blob([xml], { type: 'application/xml;charset=utf-8' }), p.fileBase + '.xml');
        if (status) status.textContent = 'Cronograma .xml gerado — abra no MS Project.';
      } catch (e) {
        console.error('[MSP] Falha ao gerar XML:', e);
        if (status) status.textContent = 'Falha ao gerar o XML: ' + (e && e.message ? e.message : String(e));
      }
      setBtnLoading(btn, false);
    }

    // ══════════════ 14. CONFIG PERSISTIDA ══════════════
    function normalizarCfg(raw) {
      var o = {};
      o.fonte = (raw && ['esforco','bruto','nivel'].indexOf(raw.fonte) !== -1) ? raw.fonte : CFG_PADRAO.fonte;
      o.incluirConcluidos = raw && typeof raw.incluirConcluidos === 'boolean' ? raw.incluirConcluidos : CFG_PADRAO.incluirConcluidos;
      o.preservarDatasReais = raw && typeof raw.preservarDatasReais === 'boolean' ? raw.preservarDatasReais : CFG_PADRAO.preservarDatasReais;
      o.excluirComAviso = raw && typeof raw.excluirComAviso === 'boolean' ? raw.excluirComAviso : CFG_PADRAO.excluirComAviso;
      o.pessoas = (raw && Array.isArray(raw.pessoas) && raw.pessoas.length)
        ? raw.pessoas.map(function(n) { return String(n).trim(); }).filter(Boolean)
        : PESSOAS_PADRAO.slice();
      // Lista vazia é um estado VÁLIDO aqui (≠ pessoas): significa "sem prioridade
      // de negócio configurada", que é o padrão e mantém o comportamento anterior.
      o.etiquetasPrioridadeNegocio = (raw && Array.isArray(raw.etiquetasPrioridadeNegocio))
        ? raw.etiquetasPrioridadeNegocio.map(function(n) { return String(n).trim(); }).filter(Boolean)
        : [];
      return o;
    }
    function carregarCfg() {
      return t.get('board', 'shared', CFG_KEY).then(function(raw) {
        cfg = normalizarCfg(raw); cfgCarregada = true;
      }).catch(function() { cfg = normalizarCfg(null); cfgCarregada = true; });
    }
    var persistirCfg = debounce(function() {
      t.set('board', 'shared', CFG_KEY, cfg).catch(function() {});
    }, 600);
    function carregarBoardNome() {
      return t.board('name').then(function(b) {
        boardNome = (b && b.name) ? b.name : null;
      }).catch(function() { boardNome = null; });
    }

    // ══════════════ 15. INTERFACE ══════════════
    var FONTES = [
      { v: 'esforco', label: 'Esforço ativo (real do card + mediana como fallback)' },
      { v: 'bruto',   label: 'Lead time bruto (KPI6, sem descontar filas)' },
      { v: 'nivel',   label: 'Sempre mediana histórica por Nível de Esforço' }
    ];

    function tile(rotulo, valor, cor) {
      return '<div class="msp-tile">' +
        '<div class="msp-tile-n" style="color:' + cor + '">' + valor + '</div>' +
        '<div class="msp-tile-l">' + escHtml(rotulo) + '</div></div>';
    }

    function desenhar() {
      var el = document.getElementById('msp-content');
      var p = construir();
      var v = p.validacao;
      var h = '';

      h += '<div class="msp-card">';
      h += '<div class="msp-h1">Exportar para o Microsoft Project</div>';
      h += '<p class="msp-p">Transforma os cards em cronograma real: hierarquia <strong>Projeto › Cliente › Etapa › Atividade</strong>, ' +
        'duração vinda dos indicadores de tempo já calculados pelo Power-Up, recursos reconhecidos nas etiquetas, ' +
        'predecessoras encadeando as etapas de cada cliente e calendário de ' + HORAS_DIA + 'h/dia com feriados nacionais.</p>';
      h += '<p class="msp-p msp-muted">Usa exclusivamente os dados já carregados na aba “Tempo real” — nenhuma consulta nova ao Trello. ' +
        'Base histórica: ' + p.base.totalConcluidos + ' cards concluídos (abertos + arquivados elegíveis).</p>';
      h += '</div>';

      // ── configuração ──
      h += '<div class="msp-card"><div class="msp-h2">Configuração</div><div class="msp-grid">';
      h += '<div class="msp-field"><label for="msp-fonte">Fonte da duração</label><select id="msp-fonte" class="msp-input">';
      FONTES.forEach(function(f) {
        h += '<option value="' + f.v + '"' + (cfg.fonte === f.v ? ' selected' : '') + '>' + escHtml(f.label) + '</option>';
      });
      h += '</select></div>';
      h += '<div class="msp-field"><label>Escopo e datas</label>' +
        '<label class="msp-chk"><input type="checkbox" id="msp-concl"' + (cfg.incluirConcluidos ? ' checked' : '') + '> Incluir cards já concluídos</label>' +
        '<label class="msp-chk"><input type="checkbox" id="msp-datas"' + (cfg.preservarDatasReais ? ' checked' : '') + '> Preservar datas reais dos concluídos</label>' +
        '<label class="msp-chk"><input type="checkbox" id="msp-avisos"' + (cfg.excluirComAviso ? ' checked' : '') + '> Excluir atividades com aviso</label>' +
        '</div>';
      h += '<div class="msp-field msp-field-wide"><label for="msp-pessoas">Pessoas reconhecidas nas etiquetas ' +
        '<span class="msp-muted">(uma por linha — só estas viram recurso)</span></label>' +
        '<textarea id="msp-pessoas" class="msp-input msp-ta" rows="4">' + escHtml(cfg.pessoas.join('\n')) + '</textarea></div>';
      h += '<div class="msp-field msp-field-wide"><label for="msp-prio">Etiquetas de prioridade de negócio ' +
        '<span class="msp-muted">(uma por linha — ex.: VIP, Contrato Prioritário. Vazio = sem prioridade de negócio)</span></label>' +
        '<textarea id="msp-prio" class="msp-input msp-ta" rows="3" placeholder="VIP">' +
        escHtml(cfg.etiquetasPrioridadeNegocio.join('\n')) + '</textarea></div>';
      h += '</div>';
      h += '<p class="msp-p msp-muted"><strong>Mudança:</strong> o campo <em>Priority</em> do MS Project — que ' +
        'governa o <em>Nivelar Tudo</em> — passou a refletir prioridade de <strong>negócio</strong>. ' +
        'A escala derivada do Nível de Esforço virou o campo <em>Esforço/Urgência</em> (Number1), informativo. ' +
        'Sem etiquetas configuradas acima, o Priority continua idêntico ao de antes. ' +
        'Etiquetas listadas aqui deixam de ser candidatas a nome de Cliente.</p>';
      h += '</div>';

      // ── validação ──
      h += '<div class="msp-card"><div class="msp-h2">Validação</div><div class="msp-tiles">';
      h += tile('analisadas', v.total, 'var(--ink)');
      h += tile('prontas', v.prontas, 'var(--ok-text)');
      h += tile('com aviso', v.comAviso, v.comAviso ? 'var(--warn-text)' : 'var(--muted)');
      h += tile('bloqueadas', v.bloqueadas, v.bloqueadas ? 'var(--danger-text)' : 'var(--muted)');
      h += tile('a exportar', p.exportaveis.length, 'var(--ink)');
      h += tile('recursos', p.recursos.length, 'var(--ink)');
      h += '</div>';

      var probs = Object.keys(ROTULO_PROBLEMA).filter(function(k) { return v.contagem[k] > 0; });
      if (probs.length) {
        h += '<table class="msp-table"><thead><tr><th>Severidade</th><th>Ocorrência</th><th>Qtde</th><th></th></tr></thead><tbody>';
        probs.forEach(function(k) {
          var r = ROTULO_PROBLEMA[k];
          var badge = r.sev === 'bloq' ? '<span class="msp-badge msp-bad">bloqueio</span>'
            : (r.sev === 'aviso' ? '<span class="msp-badge msp-warn">aviso</span>' : '<span class="msp-badge msp-info">info</span>');
          h += '<tr><td>' + badge + '</td><td>' + escHtml(r.texto) + '</td><td class="msp-num">' + v.contagem[k] + '</td>' +
            '<td><button class="btn-table-download" data-prob="' + k + '">ver cards</button></td></tr>';
        });
        h += '</tbody></table>';
      } else {
        h += '<p class="msp-p msp-ok">Nenhum problema encontrado — todas as atividades estão prontas.</p>';
      }
      if (v.ciclos) {
        h += '<p class="msp-p msp-bad-text">⚠️ ' + v.ciclos + ' predecessora(s) inconsistente(s) detectada(s). ' +
          'Não deveria acontecer com o encadeamento canônico — não exporte sem verificar.</p>';
      }
      h += '</div>';

      // ── base histórica (tempo por etapa) ──
      var etapasComDado = FLOW_LISTS.filter(function(e) { return p.base.etapa[e] && p.base.etapa[e].n > 0; });
      h += '<div class="msp-card"><div class="msp-h2">Tempo histórico por etapa <span class="msp-muted">(mediana — alimenta a estimativa)</span></div>';
      if (etapasComDado.length) {
        h += '<table class="msp-table"><thead><tr><th>Etapa</th><th>Amostras</th><th>Mediana</th><th>Mediana (d.u.)</th><th>Mín–Máx</th></tr></thead><tbody>';
        etapasComDado.forEach(function(e) {
          var s = p.base.etapa[e];
          h += '<tr><td>' + escHtml(e) + '</td><td class="msp-num">' + s.n + '</td><td class="msp-num">' + fmtHoras(s.med) +
            '</td><td class="msp-num">' + fmtDias(h2d(s.med)) + '</td><td class="msp-num msp-muted">' +
            fmtHoras(s.min) + ' – ' + fmtHoras(s.max) + '</td></tr>';
        });
        h += '</tbody></table>';
      } else {
        h += '<p class="msp-p msp-muted">Ainda não há cards concluídos suficientes para calcular medianas por etapa.</p>';
      }
      var linhasNivel = NIVEIS_ESFORCO.filter(function(n) { return p.base.nivel[n].n > 0; });
      if (linhasNivel.length) {
        h += '<table class="msp-table" style="margin-top:14px"><thead><tr><th>Nível de Esforço</th><th>Amostras</th><th>Mediana do esforço</th><th>Em dias úteis</th></tr></thead><tbody>';
        linhasNivel.forEach(function(n) {
          var s = p.base.nivel[n];
          h += '<tr><td><span class="msp-dot" style="background:' + (COR_NIVEL[n] || '#75757F') + '"></span>' + escHtml(n) +
            '</td><td class="msp-num">' + s.n + '</td><td class="msp-num">' + fmtHoras(s.med) +
            '</td><td class="msp-num">' + fmtDias(h2d(s.med)) + '</td></tr>';
        });
        h += '</tbody></table>';
      }
      h += '</div>';

      // ── ações ──
      h += '<div class="msp-card"><div class="msp-h2">Gerar arquivos</div>';
      h += '<div class="msp-actions">';
      h += '<button class="btn" id="msp-xml"' + (p.exportaveis.length ? '' : ' disabled') + '>⬇ Cronograma (.xml para o MS Project)</button>';
      h += '<button class="btn btn-secondary" id="msp-xlsx"' + (p.exportaveis.length ? '' : ' disabled') + '>⬇ Planilha de auditoria (.xlsx)</button>';
      h += '<span class="msp-status" id="msp-status"></span>';
      h += '</div>';
      h += '<p class="msp-p msp-muted">O <strong>.xml</strong> abre direto no MS Project com hierarquia, durações, predecessoras, recursos, ' +
        'atribuições e calendário. O <strong>.xlsx</strong> é para conferência (inclui a base histórica e o relatório de validação). ' +
        'Arquivos <code>.mpp</code> não podem ser gerados no navegador — é formato binário fechado; o .xml é o caminho oficial da Microsoft.</p>';
      h += '</div>';

      el.innerHTML = h;
      conectar(p);
    }

    function conectar(p) {
      function recarregar() { persistirCfg(); desenhar(); }

      var sel = document.getElementById('msp-fonte');
      if (sel) sel.addEventListener('change', function() { cfg.fonte = this.value; recarregar(); });
      var cc = document.getElementById('msp-concl');
      if (cc) cc.addEventListener('change', function() { cfg.incluirConcluidos = this.checked; recarregar(); });
      var cd = document.getElementById('msp-datas');
      if (cd) cd.addEventListener('change', function() { cfg.preservarDatasReais = this.checked; recarregar(); });
      var ca = document.getElementById('msp-avisos');
      if (ca) ca.addEventListener('change', function() { cfg.excluirComAviso = this.checked; recarregar(); });

      // Lista de pessoas: aplica no blur (não a cada tecla) para não redesenhar durante a digitação.
      var ta = document.getElementById('msp-pessoas');
      if (ta) ta.addEventListener('blur', function() {
        var novas = this.value.split('\n').map(function(s) { return s.trim(); }).filter(Boolean);
        if (novas.join('|') === cfg.pessoas.join('|')) return;
        cfg.pessoas = novas.length ? novas : PESSOAS_PADRAO.slice();
        recarregar();
      });

      // Etiquetas de prioridade de negócio: lista VAZIA é válida (= sem prioridade).
      var tp = document.getElementById('msp-prio');
      if (tp) tp.addEventListener('blur', function() {
        var novas = this.value.split('\n').map(function(s) { return s.trim(); }).filter(Boolean);
        if (novas.join('|') === cfg.etiquetasPrioridadeNegocio.join('|')) return;
        cfg.etiquetasPrioridadeNegocio = novas;
        recarregar();
      });

      // "ver cards" reutiliza o MESMO modal da aba Análises Personalizadas.
      document.querySelectorAll('#msp-content [data-prob]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var k = btn.getAttribute('data-prob');
          var lista = p.validacao.cards[k] || [];
          if (lista.length && typeof CP !== 'undefined' && CP.openCards) {
            CP.openCards((ROTULO_PROBLEMA[k] || {}).texto || k, lista, '#0A0A0A');
          }
        });
      });

      var status = document.getElementById('msp-status');
      var bx = document.getElementById('msp-xml');
      if (bx) bx.addEventListener('click', function() { exportarXML(ultimoPacote || p, bx, status); });
      var bp = document.getElementById('msp-xlsx');
      if (bp) bp.addEventListener('click', function() { gerarXLSX(ultimoPacote || p, bp, status); });
    }

    // ══════════════ API PÚBLICA ══════════════
    return {
      render: function() {
        var el = document.getElementById('msp-content');
        if (!cachedData || !cachedData.cards || !cachedData.cards.length) {
          el.innerHTML = '<div class="no-data"><p>Carregue os dados na aba “Tempo real” primeiro.</p></div>';
          return;
        }
        if (!cfgCarregada) {
          el.innerHTML = '<div class="spinner-wrap"><div class="spinner"></div><p>Preparando exportação…</p></div>';
          Promise.all([carregarCfg(), carregarBoardNome()]).then(function() { desenhar(); })
            .catch(function() { cfg = normalizarCfg(null); cfgCarregada = true; desenhar(); });
          return;
        }
        desenhar();
      },
      // ── ganchos de inspeção/teste (não usados pela UI; seguros de chamar no console) ──
      _construir: construir,
      _gerarXML: gerarXML,
      _pessoaDaEtiqueta: function(label) { return pessoaDaEtiqueta(label, construirPessoas(cfg ? cfg.pessoas : PESSOAS_PADRAO)); },
      _cfg: function(patch) {
        if (!cfg) cfg = normalizarCfg(null);
        if (patch) {
          Object.keys(patch).forEach(function(k) { cfg[k] = patch[k]; });
          cfg = normalizarCfg(cfg);   // sempre volta a um estado válido (nunca null/tipo errado)
        }
        return cfg;
      },
      _agendar: function(from, horas, anoIni, anoFim) {
        var f = montarFeriados(anoIni || new Date(from).getFullYear(), anoFim || (new Date(from).getFullYear() + 1));
        return { fim: somarHorasUteis(new Date(from), horas, f), feriados: f };
      },
      _planilha: { cronograma: linhasCronograma, base: linhasBase, validacao: linhasValidacao, colunas: COLS_CRONO },
      _gerarXLSX: gerarXLSX
    };
  })();

  return MSP;
}
