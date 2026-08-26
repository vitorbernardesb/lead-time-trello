// ══════════════════════════════════════════════════════════════════════
//  ANÁLISES PERSONALIZADAS  (módulo aditivo e autocontido)
//  ───────────────────────────────────────────────────────────────────
//  Fluxo (nenhuma fórmula recriada):
//    cachedData.cards ─▶ camada de agrupamento (filtro do painel)
//                    ─▶ calcKPIs / calcPrimeiraEntrega  (PIPELINE EXISTENTE)
//                    ─▶ KPIs derivados (só de saídas/campos já existentes)
//                    ─▶ dashboard + gráficos + comparativo + exportação
//  Persistência: t.get/set('board','shared','customPanels') — mesmo mecanismo
//  do healthConfig. Limite de 5 painéis SÓ na UI; a arquitetura é ilimitada.
// ══════════════════════════════════════════════════════════════════════
import { NIVEIS_ESFORCO, PRIMEIRA_ENTREGA_EPOCH, DEFAULTS } from './config.js';
import { t, cachedData } from './state.js';
import { debounce, round1, mean, median } from './core-util.js';
import { escHtml, fmtDateTime, fmtDateBR, fmtHoras, fmtDias } from './core-fmt.js';
import { loadHtml2Canvas, loadJsPDF, setBtnLoading, downloadCanvas } from './core-io.js';

// Recebe do script principal apenas o que vive la (calculo de KPIs e recarga da
// aba Tempo real). Injecao explicita em vez de import evita ciclo entre modulos.
export function createCP(deps) {
  const { calcKPIs, calcPrimeiraEntrega, loadRealtime } = deps;

  const CP = (function() {
    // Paleta premium pré-validada (CVD-safe; o comparativo usa rótulos+tabela como
    // codificação secundária). São apenas swatches — o usuário escolhe livremente.
    var PANEL_COLORS = ['#2563EB','#DC2626','#059669','#8B5CF6','#F59E0B','#0D9488','#DB2777','#4F46E5'];
    var UI_LIMIT = 5;
    var MUTED = '#75757F', INK = '#0A0A0A', INK2 = '#55555E', TRACK = 'rgba(10,10,15,0.07)';

    var panels = [];
    var loaded = false;
    var initDone = false;
    var computeCache = {};   // memo por render: panel.id → resultado
    var buckets = {};        // bucketId → { title, cards } (clique em gráfico/kpi)
    var bucketSeq = 0;
    var tooltipEl = null;

    // ── camada de agrupamento (genérica; hoje só "labels", extensível) ──
    // Para adicionar um critério futuro (cliente, responsável, lista, custom field…),
    // basta registrar aqui uma estratégia com { options(cards), matches(card, values) }.
    var STRATEGIES = {
      labels: {
        id: 'labels', label: 'Etiquetas', unit: 'etiqueta', unitPlural: 'etiquetas',
        options: function(cards) {
          var counts = {};
          cards.forEach(function(c) {
            (c.labels || []).forEach(function(n) {
              if (!n) return;
              counts[n] = (counts[n] || 0) + 1;
            });
          });
          return Object.keys(counts).sort(function(a, b) {
            return counts[b] - counts[a] || a.localeCompare(b);
          }).map(function(n) { return { value: n, count: counts[n] }; });
        },
        // Card conta UMA vez mesmo com várias etiquetas do painel (some → boolean).
        matches: function(card, values) {
          var ls = card.labels || [];
          for (var i = 0; i < ls.length; i++) if (values.indexOf(ls[i]) !== -1) return true;
          return false;
        }
      },
      nivelEsforco: {
        id: 'nivelEsforco', label: 'Nível de Esforço', unit: 'nível', unitPlural: 'níveis',
        options: function(cards) {
          var counts = {};
          cards.forEach(function(c) {
            var n = c.nivelEsforco || 'Sem nível';
            counts[n] = (counts[n] || 0) + 1;
          });
          var order = NIVEIS_ESFORCO.concat(['Sem nível']);
          return order.filter(function(n) { return counts[n]; }).map(function(n) { return { value: n, count: counts[n] }; });
        },
        matches: function(card, values) {
          var n = card.nivelEsforco || 'Sem nível';
          return values.indexOf(n) !== -1;
        }
      },
      responsavel: {
        id: 'responsavel', label: 'Responsável', unit: 'responsável', unitPlural: 'responsáveis',
        options: function(cards) {
          var counts = {};
          cards.forEach(function(c) {
            (c.members || []).forEach(function(n) {
              if (!n) return;
              counts[n] = (counts[n] || 0) + 1;
            });
          });
          return Object.keys(counts).sort(function(a, b) {
            return counts[b] - counts[a] || a.localeCompare(b);
          }).map(function(n) { return { value: n, count: counts[n] }; });
        },
        // Card conta UMA vez mesmo com vários responsáveis do painel (some → boolean).
        matches: function(card, values) {
          var ms = card.members || [];
          for (var i = 0; i < ms.length; i++) if (values.indexOf(ms[i]) !== -1) return true;
          return false;
        }
      }
    };
    function strategyOf(p) { return STRATEGIES[p.criterion] || STRATEGIES.labels; }
    // Filtro rápido (transiente, não persistido): subconjunto das etiquetas do painel.
    // Vazio = considera todas as etiquetas configuradas no painel (comportamento atual).
    function effectiveValues(p) { return (p.__filterSel && p.__filterSel.length) ? p.__filterSel : (p.values || []); }

    // ── helpers numéricos/cor (derivados; não tocam o pipeline) ──
    function nf(x) { return String(x).replace('.', ','); }
    function pct1(x) { return nf(round1(x)) + '%'; }
    function median(arr) {
      if (!arr || !arr.length) return 0;
      var s = arr.slice().sort(function(a, b) { return a - b; });
      var m = Math.floor(s.length / 2);
      return round1(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
    }
    function hexToRgb(h) {
      h = String(h).replace('#', '');
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
    }
    function tint(hex, p) { var c = hexToRgb(hex); function m(v) { return Math.round(v + (255 - v) * p); } return 'rgb(' + m(c.r) + ',' + m(c.g) + ',' + m(c.b) + ')'; }
    function shade(hex, p) { var c = hexToRgb(hex); function m(v) { return Math.round(v * (1 - p)); } return 'rgb(' + m(c.r) + ',' + m(c.g) + ',' + m(c.b) + ')'; }
    // Tons dos níveis derivados da cor do painel (família de 1 matiz = segue a entidade).
    function nivelCor(color) { return { 'MUITO ALTO': shade(color, 0.34), 'ALTO': shade(color, 0.18), 'MÉDIO': color, 'BAIXO': tint(color, 0.42), 'Sem nível': tint(color, 0.68) }; }

    // ── persistência (mesmo mecanismo do healthConfig) ──
    function normalize(arr) {
      if (!Array.isArray(arr)) return [];
      return arr.map(function(p, i) {
        return {
          id: p.id || ('p' + Date.now() + '_' + i),
          name: typeof p.name === 'string' && p.name.trim() ? p.name : 'Painel ' + (i + 1),
          color: PANEL_COLORS.indexOf(p.color) !== -1 || /^#[0-9A-Fa-f]{6}$/.test(p.color || '') ? p.color : PANEL_COLORS[i % PANEL_COLORS.length],
          criterion: p.criterion && STRATEGIES[p.criterion] ? p.criterion : 'labels',
          values: Array.isArray(p.values) ? p.values.slice() : [],
          updatedAt: p.updatedAt || Date.now()
        };
      });
    }
    function load() {
      return t.get('board', 'shared', 'customPanels').then(function(arr) {
        panels = normalize(arr); loaded = true; return panels;
      }).catch(function() { panels = []; loaded = true; return panels; });
    }
    function persist() { return t.set('board', 'shared', 'customPanels', panels).catch(function() {}); }

    // ── COMPUTE de um painel — reutiliza integralmente o pipeline existente ──
    function computePanel(p) {
      var vals = effectiveValues(p);
      var cacheKey = p.id + '::' + vals.slice().sort().join('');
      if (computeCache[cacheKey]) return computeCache[cacheKey];
      var strat = strategyOf(p);
      var open = (cachedData && cachedData.cards) ? cachedData.cards : [];
      var arch = (cachedData && cachedData.archived) ? cachedData.archived : [];
      var cfg = (cachedData && cachedData.config) ? cachedData.config : DEFAULTS;
      var sub = vals.length ? open.filter(function(c) { return strat.matches(c, vals); }) : [];
      var subArch = vals.length ? arch.filter(function(c) { return strat.matches(c, vals); }) : [];
      var subAll = sub.concat(subArch); // arquivados só entram na 1ª entrega (igual ao realtime)

      var kpis = calcKPIs(sub, cfg);              // ◀── PIPELINE EXISTENTE, intocado
      var pe = calcPrimeiraEntrega(subAll);        // ◀── PIPELINE EXISTENTE, intocado

      // Derivados — só de campos/saídas que já existem (nenhuma fórmula nova de KPI):
      var concluidas = sub.filter(function(c) { return c.isConcluido; });
      var comRetra = sub.filter(function(c) { return c.hasRetrabalho; });
      var entregues = subAll.filter(function(c) { return c.primeiraEntrega; });
      var horas = entregues.map(function(c) { return c.primeiraEntrega.horas; });
      var totalBoard = open.length;

      var r = {
        panel: p, cards: sub, cardsAll: subAll, entregues: entregues,
        concluidas: concluidas, comRetra: comRetra,
        kpis: kpis, pe: pe,
        count: sub.length,
        nConcluidas: concluidas.length,
        retrabalhos: kpis.kpi2,                                             // = KPI existente
        pctRetrabalho: sub.length ? round1(comRetra.length / sub.length * 100) : 0,
        eficiencia: sub.length ? round1((sub.length - comRetra.length) / sub.length * 100) : 0,
        tempoMedio: mean(horas), tempoMediano: median(horas),
        participacao: totalBoard ? round1(sub.length / totalBoard * 100) : 0
      };
      computeCache[cacheKey] = r;
      return r;
    }

    // ── registro de "buckets" clicáveis (KPI/segmento → lista de cards) ──
    function bucket(title, cards) {
      var id = 'b' + (++bucketSeq);
      buckets[id] = { title: title, cards: cards || [] };
      return id;
    }

    // ══════════ GRÁFICOS SVG (leves, interativos, na cor do painel) ══════════
    function seg(bId, tip, body) {
      return '<g class="cp-seg" data-b="' + bId + '" data-tip="' + escHtml(tip) + '">' + body +
        '<title>' + escHtml(tip) + '</title></g>';
    }
    function emptyChart(msg) { return '<div class="cp-chart-empty">' + escHtml(msg || 'Sem dados no período.') + '</div>'; }

    // Barras verticais (item: {label,value,bucketId,tip,color?})
    function vBars(items, color) {
      if (!items.length) return emptyChart();
      var W = 340, H = 180, padT = 18, padB = 30, padX = 10;
      var plotH = H - padT - padB, plotW = W - padX * 2;
      var max = Math.max.apply(null, items.map(function(i) { return i.value; }).concat([1]));
      var n = items.length, gap = 16, bw = Math.min(58, (plotW - gap * (n - 1)) / n);
      var totalW = bw * n + gap * (n - 1), x0 = padX + (plotW - totalW) / 2;
      var s = '<svg class="cp-chart-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" role="img">';
      s += '<line x1="' + padX + '" y1="' + (padT + plotH) + '" x2="' + (W - padX) + '" y2="' + (padT + plotH) + '" stroke="rgba(10,10,15,0.10)" stroke-width="1"/>';
      items.forEach(function(it, i) {
        var h = max > 0 ? (it.value / max) * plotH : 0; if (it.value > 0 && h < 3) h = 3;
        var x = x0 + i * (bw + gap), y = padT + plotH - h;
        s += seg(it.bucketId, it.tip, '<rect x="' + x + '" y="' + y + '" width="' + bw + '" height="' + h + '" rx="4" fill="' + (it.color || color) + '"/>');
        s += '<text class="cp-val-label" x="' + (x + bw / 2) + '" y="' + (y - 5) + '" text-anchor="middle">' + nf(it.value) + '</text>';
        s += '<text class="cp-axis-label" x="' + (x + bw / 2) + '" y="' + (padT + plotH + 15) + '" text-anchor="middle">' + escHtml(it.label) + '</text>';
      });
      return s + '</svg>';
    }

    // Barras horizontais (valor numérico à direita)
    function hBars(items, color, unitFmt) {
      if (!items.length) return emptyChart();
      var W = 340, rowH = 34, padTop = 6, labelW = 62, valW = 52;
      var H = padTop + items.length * rowH;
      var barX = labelW, barMaxW = W - labelW - valW;
      var max = Math.max.apply(null, items.map(function(i) { return i.value; }).concat([0.0001]));
      var s = '<svg class="cp-chart-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" role="img">';
      items.forEach(function(it, i) {
        var cy = padTop + i * rowH + rowH / 2;
        var w = max > 0 ? Math.max(it.value > 0 ? 4 : 0, it.value / max * barMaxW) : 0;
        s += '<text class="cp-axis-label" x="0" y="' + (cy + 3) + '">' + escHtml(it.label) + '</text>';
        s += '<rect x="' + barX + '" y="' + (cy - 8) + '" width="' + barMaxW + '" height="16" rx="8" fill="' + TRACK + '"/>';
        s += seg(it.bucketId, it.tip, '<rect x="' + barX + '" y="' + (cy - 8) + '" width="' + w + '" height="16" rx="8" fill="' + (it.color || color) + '"/>');
        s += '<text class="cp-val-label" x="' + W + '" y="' + (cy + 3) + '" text-anchor="end">' + escHtml(unitFmt ? unitFmt(it.value) : nf(it.value)) + '</text>';
      });
      return s + '</svg>';
    }

    // Rosca (segments: {label,value,color,bucketId,tip})
    function doughnut(segments) {
      var total = segments.reduce(function(a, s2) { return a + s2.value; }, 0);
      if (total <= 0) return emptyChart('Nenhum card no painel.');
      var W = 340, H = 180, cx = 92, cy = 90, r = 60, sw = 22, C = 2 * Math.PI * r, off = 0;
      var s = '<svg class="cp-chart-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" role="img">';
      s += '<g transform="rotate(-90 ' + cx + ' ' + cy + ')">';
      segments.forEach(function(sg) {
        if (sg.value <= 0) return;
        var len = sg.value / total * C;
        var body = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + sg.color + '" stroke-width="' + sw +
          '" stroke-dasharray="' + len + ' ' + (C - len) + '" stroke-dashoffset="' + (-off) + '"/>';
        s += seg(sg.bucketId, sg.tip, body);
        off += len;
      });
      s += '</g>';
      // centro: total
      s += '<text x="' + cx + '" y="' + (cy - 3) + '" text-anchor="middle" font-size="24" font-weight="700" fill="' + INK + '" font-family="inherit">' + total + '</text>';
      s += '<text x="' + cx + '" y="' + (cy + 14) + '" text-anchor="middle" font-size="9" letter-spacing="0.5" fill="' + MUTED + '" font-family="inherit">CARDS</text>';
      // legenda à direita
      var ly = 44;
      segments.forEach(function(sg) {
        s += '<rect x="184" y="' + (ly - 9) + '" width="11" height="11" rx="3" fill="' + sg.color + '"/>';
        s += '<text class="cp-axis-label" x="202" y="' + ly + '" style="font-size:11px">' + escHtml(sg.label) + '</text>';
        s += '<text x="' + W + '" y="' + ly + '" text-anchor="end" font-size="11" font-weight="700" fill="' + INK2 + '" font-family="inherit">' + sg.value + '</text>';
        ly += 26;
      });
      return s + '</svg>';
    }

    // Barra empilhada única (segments: {label,value,color,bucketId,tip}) + legenda
    function stacked(segments) {
      var total = segments.reduce(function(a, s2) { return a + s2.value; }, 0);
      if (total <= 0) return emptyChart('Nenhuma atividade classificada.');
      var W = 340, barH = 30, y = 8, x = 0, GAP = 2;
      var s = '<svg class="cp-chart-svg" viewBox="0 0 ' + W + ' ' + (barH + 16) + '" preserveAspectRatio="none" role="img">';
      segments.forEach(function(sg) {
        if (sg.value <= 0) return;
        var w = sg.value / total * W;
        var drawW = Math.max(0, w - GAP);
        s += seg(sg.bucketId, sg.tip, '<rect x="' + x + '" y="' + y + '" width="' + drawW + '" height="' + barH + '" rx="3" fill="' + sg.color + '"/>');
        if (w > 26) s += '<text x="' + (x + drawW / 2) + '" y="' + (y + barH / 2 + 4) + '" text-anchor="middle" font-size="12" font-weight="700" fill="#fff" font-family="inherit">' + sg.value + '</text>';
        x += w;
      });
      return s + '</svg>';
    }
    function legend(segments) {
      var h = '<div class="cp-legend">';
      segments.forEach(function(sg) {
        if (sg.value <= 0 && sg.hideEmpty) return;
        h += '<span class="cp-legend-item"><span class="cp-legend-swatch" style="background:' + sg.color + '"></span>' + escHtml(sg.label) + '</span>';
      });
      return h + '</div>';
    }

    // Linha temporal (points: {label,value,bucketId,tip})
    function lineChart(points, color) {
      if (!points.length) return emptyChart('Sem conclusões no período.');
      var W = 680, H = 190, padL = 30, padR = 14, padT = 16, padB = 28;
      var plotW = W - padL - padR, plotH = H - padT - padB;
      var max = Math.max.apply(null, points.map(function(p) { return p.value; }).concat([1]));
      var n = points.length;
      function px(i) { return padL + (n === 1 ? plotW / 2 : i / (n - 1) * plotW); }
      function py(v) { return padT + plotH - (max > 0 ? v / max * plotH : 0); }
      var s = '<svg class="cp-chart-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" role="img">';
      // grade horizontal (recessiva)
      for (var g = 0; g <= 2; g++) {
        var gy = padT + plotH - g / 2 * plotH;
        s += '<line x1="' + padL + '" y1="' + gy + '" x2="' + (W - padR) + '" y2="' + gy + '" stroke="rgba(10,10,15,0.06)" stroke-width="1"/>';
        s += '<text class="cp-axis-label" x="' + (padL - 6) + '" y="' + (gy + 3) + '" text-anchor="end">' + Math.round(g / 2 * max) + '</text>';
      }
      var d = '', area = '';
      points.forEach(function(p, i) { var X = px(i), Y = py(p.value); d += (i ? 'L' : 'M') + X + ' ' + Y + ' '; });
      area = 'M' + px(0) + ' ' + (padT + plotH) + ' ' + d.replace('M', 'L') + 'L' + px(n - 1) + ' ' + (padT + plotH) + ' Z';
      s += '<path d="' + area + '" fill="' + tint(color, 0.82) + '" opacity="0.6"/>';
      s += '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
      points.forEach(function(p, i) {
        var X = px(i), Y = py(p.value);
        s += seg(p.bucketId, p.tip, '<circle class="cp-dot-mark" cx="' + X + '" cy="' + Y + '" r="4.5" fill="#fff" stroke="' + color + '" stroke-width="2"/>');
        if (i % Math.ceil(n / 8) === 0 || i === n - 1) s += '<text class="cp-axis-label" x="' + X + '" y="' + (H - 10) + '" text-anchor="middle">' + escHtml(p.label) + '</text>';
      });
      return s + '</svg>';
    }

    // ── conjuntos de dados dos gráficos a partir do compute (buckets p/ clique) ──
    function chartConcluidas(r) {
      var cor = nivelCor(r.panel.color);
      var groups = ['BAIXO', 'MÉDIO', 'ALTO', 'MUITO ALTO', 'Sem nível'];
      var items = groups.map(function(g) {
        var cs = r.concluidas.filter(function(c) { return (c.nivelEsforco || 'Sem nível') === g; });
        return { label: g === 'Sem nível' ? 'S/ nível' : g, value: cs.length, color: cor[g],
          bucketId: bucket('Concluídas · ' + g + ' — ' + r.panel.name, cs),
          tip: '<b>' + cs.length + '</b> concluída(s) · ' + g };
      }).filter(function(it) { return it.value > 0; });
      if (!items.length) return emptyChart('Nenhuma atividade concluída.');
      return vBars(items, r.panel.color);
    }
    function chartRetrabalho(r) {
      var cor = r.panel.color;
      var segs = [
        { label: 'Com retrabalho', value: r.comRetra.length, color: cor,
          bucketId: bucket('Com retrabalho — ' + r.panel.name, r.comRetra), tip: '<b>' + r.comRetra.length + '</b> card(s) com retrabalho' },
        { label: 'Sem retrabalho', value: r.count - r.comRetra.length, color: tint(cor, 0.6),
          bucketId: bucket('Sem retrabalho — ' + r.panel.name, r.cards.filter(function(c) { return !c.hasRetrabalho; })),
          tip: '<b>' + (r.count - r.comRetra.length) + '</b> card(s) sem retrabalho' }
      ];
      return doughnut(segs);
    }
    function chartTempoEntrega(r) {
      var cor = nivelCor(r.panel.color);
      var items = NIVEIS_ESFORCO.map(function(nv) {
        var g = r.pe.niveis[nv];
        var cs = r.entregues.filter(function(c) { return c.nivelEsforco === nv; });
        return { label: nv, value: g.avgHoras, color: cor[nv],
          bucketId: bucket('1ª entrega · ' + nv + ' — ' + r.panel.name, cs),
          tip: nv + ': <b>' + fmtHoras(g.avgHoras) + '</b> úteis · ' + fmtDias(g.avgDias) + ' · ' + g.n + ' card(s)' };
      });
      if (!items.some(function(i) { return i.value > 0; })) return emptyChart('Nenhuma 1ª entrega registrada.');
      return hBars(items, r.panel.color, function(v) { return fmtHoras(v); });
    }
    function chartQtdeDificuldade(r) {
      var cor = nivelCor(r.panel.color);
      var groups = NIVEIS_ESFORCO.concat(['Sem nível']);
      var segs = groups.map(function(g) {
        var cs = r.cardsAll.filter(function(c) { return (c.nivelEsforco || 'Sem nível') === g; });
        return { label: g, value: cs.length, color: cor[g],
          bucketId: bucket('Dificuldade · ' + g + ' — ' + r.panel.name, cs),
          tip: g + ': <b>' + cs.length + '</b> card(s)' };
      });
      var chart = stacked(segs);
      return chart + legend(segs);
    }
    function chartEvolucao(r) {
      // Concluídas por semana (segunda) dentro do período coberto pelos dados.
      var done = r.concluidas.filter(function(c) { return c.concludedAt; });
      if (!done.length) return emptyChart('Sem conclusões para plotar.');
      function weekStart(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); var day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); return x; }
      var byWeek = {};
      done.forEach(function(c) { var w = weekStart(c.concludedAt); var k = w.getTime(); (byWeek[k] = byWeek[k] || []).push(c); });
      var keys = Object.keys(byWeek).map(Number).sort(function(a, b) { return a - b; });
      // preenche semanas vazias entre a primeira e a última (linha contínua)
      var pts = [];
      if (keys.length) {
        var first = keys[0], last = keys[keys.length - 1], WEEK = 604800000;
        for (var k = first; k <= last; k += WEEK) {
          var cs = byWeek[k] || [];
          var dt = new Date(k);
          pts.push({ label: fmtDateBR(dt).slice(0, 5), value: cs.length,
            bucketId: bucket('Concluídas na semana de ' + fmtDateBR(dt) + ' — ' + r.panel.name, cs),
            tip: 'Semana de <b>' + fmtDateBR(dt) + '</b>: ' + cs.length + ' concluída(s)' });
        }
      }
      return lineChart(pts, r.panel.color);
    }

    // ══════════════ KPIs derivados (cards clicáveis) ══════════════
    function kpiCard(name, valueHtml, sub, cards, title) {
      var bId = bucket(title, cards);
      return '<div class="cp-kpi" data-b="' + bId + '"><div class="cp-kpi-name">' + escHtml(name) + '</div>' +
        '<div class="cp-kpi-value">' + valueHtml + '</div>' +
        (sub ? '<div class="cp-kpi-sub">' + escHtml(sub) + '</div>' : '') + '</div>';
    }
    function panelKpis(r) {
      var pn = r.panel.name;
      var semRW = r.cards.filter(function(c) { return !c.hasRetrabalho; });
      var h = '<div class="cp-kpi-grid cp-kpi-6">';
      h += kpiCard('Atividades concluídas', r.nConcluidas + '', 'total no painel', r.concluidas, 'Concluídas — ' + pn);
      h += kpiCard('Retrabalhos', r.retrabalhos + '', pct1(r.pctRetrabalho) + ' dos cards', r.comRetra, 'Cards com retrabalho — ' + pn);
      h += kpiCard('Eficiência', pct1(r.eficiencia), 'cards sem retrabalho', semRW, 'Cards sem retrabalho — ' + pn);
      h += kpiCard('Participação', pct1(r.participacao), 'do total do board', r.cards, 'Todos os cards — ' + pn);
      h += kpiCard('Tempo médio 1ª entrega', nf(round1(r.tempoMedio)) + '<span class="cp-unit">h úteis</span>', r.entregues.length + ' entregue(s)', r.entregues, 'Entregues — ' + pn);
      h += kpiCard('Tempo mediano 1ª entrega', nf(round1(r.tempoMediano)) + '<span class="cp-unit">h úteis</span>', 'resistente a outliers', r.entregues, 'Entregues — ' + pn);
      return h + '</div>';
    }

    // ══════════════ corpo (lazy) de um painel ══════════════
    function buildPanelBody(p) {
      if (!cachedData) return '<div class="cp-cards-empty">Carregue a aba <b>Tempo real</b> para ver as métricas deste painel.</div>';
      var r = computePanel(p);
      if (!p.values.length) return '<div class="cp-cards-empty">Nenhum valor selecionado para <b>' + escHtml(strategyOf(p).label) + '</b>. Clique em <b>Configurar</b> para escolher os valores do painel.</div>';
      var h = panelKpis(r);
      h += '<div class="cp-charts">';
      h += '<div class="cp-chart-card"><div class="cp-chart-title">Atividades concluídas</div><div class="cp-chart-sub">por nível de esforço</div>' + chartConcluidas(r) + '</div>';
      h += '<div class="cp-chart-card"><div class="cp-chart-title">Retrabalhos</div><div class="cp-chart-sub">proporção de cards</div>' + chartRetrabalho(r) + '</div>';
      h += '<div class="cp-chart-card"><div class="cp-chart-title">Tempo até 1ª entrega</div><div class="cp-chart-sub">média de horas úteis por dificuldade</div>' + chartTempoEntrega(r) + '</div>';
      h += '<div class="cp-chart-card"><div class="cp-chart-title">Quantidade por dificuldade</div><div class="cp-chart-sub">distribuição das atividades</div>' + chartQtdeDificuldade(r) + '</div>';
      h += '<div class="cp-chart-card cp-wide"><div class="cp-chart-title">Evolução no período</div><div class="cp-chart-sub">conclusões por semana</div>' + chartEvolucao(r) + '</div>';
      h += '</div>';
      return h;
    }

    // ══════════════ comparativo entre equipes ══════════════
    function buildCompare() {
      var withVals = panels.filter(function(p) { return p.values.length; });
      if (withVals.length < 2 || !cachedData) return '';
      var rows = withVals.map(computePanel);
      var h = '<div class="cp-compare">';
      h += '<div class="cp-section-title">Comparativo entre Equipes</div>';
      h += '<div class="cp-section-sub">Mesmos indicadores do pipeline, lado a lado. Clique numa linha para ver os cards.</div>';
      h += '<div class="table-scroll"><table class="cp-compare-table"><thead><tr>' +
        '<th>Equipe</th><th>Atividades</th><th>Tempo médio</th><th>Tempo mediano</th><th>Retrabalhos</th><th>% retrabalho</th><th>Eficiência</th><th>Participação</th>' +
        '</tr></thead><tbody>';
      rows.forEach(function(r) {
        var bId = bucket('Todos os cards — ' + r.panel.name, r.cards);
        h += '<tr class="cp-compare-row-click" data-b="' + bId + '">' +
          '<td class="cp-team"><span class="cp-team-dot" style="background:' + r.panel.color + '"></span>' + escHtml(r.panel.name) + '</td>' +
          '<td>' + r.count + '</td>' +
          '<td>' + fmtHoras(r.tempoMedio) + '</td>' +
          '<td>' + fmtHoras(r.tempoMediano) + '</td>' +
          '<td>' + r.retrabalhos + '</td>' +
          '<td>' + pct1(r.pctRetrabalho) + '</td>' +
          '<td>' + pct1(r.eficiencia) + '</td>' +
          '<td>' + pct1(r.participacao) + '</td></tr>';
      });
      h += '</tbody></table></div>';
      // gráficos comparativos (cores de cada painel + rótulos = codificação secundária)
      var atividades = rows.map(function(r) { return { label: r.panel.name.slice(0, 10), value: r.count, color: r.panel.color, bucketId: bucket('Todos os cards — ' + r.panel.name, r.cards), tip: '<b>' + escHtml(r.panel.name) + '</b>: ' + r.count + ' atividade(s)' }; });
      var retra = rows.map(function(r) { return { label: r.panel.name.slice(0, 10), value: r.pctRetrabalho, color: r.panel.color, bucketId: bucket('Cards com retrabalho — ' + r.panel.name, r.comRetra), tip: '<b>' + escHtml(r.panel.name) + '</b>: ' + pct1(r.pctRetrabalho) + ' de retrabalho' }; });
      h += '<div class="cp-charts" style="margin-top:16px">';
      h += '<div class="cp-chart-card"><div class="cp-chart-title">Atividades por equipe</div><div class="cp-chart-sub">volume total</div>' + vBars(atividades) + '</div>';
      h += '<div class="cp-chart-card"><div class="cp-chart-title">Percentual de retrabalho</div><div class="cp-chart-sub">quanto menor, melhor</div>' + hBars(retra, null, function(v) { return pct1(v); }) + '</div>';
      h += '</div></div>';
      return h;
    }

    // ══════════════ RENDER principal ══════════════
    function draw() {
      computeCache = {}; buckets = {}; bucketSeq = 0; // memo/registro fresco por render
      var host = document.getElementById('custom-content');
      var h = '';
      h += '<div class="cp-intro"><div>';
      h += '<h2>Análises Personalizadas</h2>';
      h += '<p>Monte dashboards por conjuntos de etiquetas (equipes). Cada painel passa pelos mesmos KPIs, filtros e cache do dashboard — nada é recalculado por fora.</p>';
      h += '</div><div class="cp-intro-actions">';
      h += '<span class="cp-slots-hint">' + panels.length + '/' + UI_LIMIT + ' painéis</span>';
      h += '<div class="cp-actions-buttons">';
      h += '<button class="btn btn-secondary" id="cp-refresh">⟲ Atualizar dados</button>';
      h += '<button class="btn btn-secondary" id="cp-export" ' + (panels.length ? '' : 'disabled') + '>⬇ Exportar</button>';
      h += '<button class="btn" id="cp-new" ' + (panels.length >= UI_LIMIT ? 'disabled title="Limite de ' + UI_LIMIT + ' painéis"' : '') + '>+ Novo painel</button>';
      h += '</div></div></div>';

      if (!cachedData) h += '<div class="alert-banner success" style="border-radius:10px;margin-bottom:18px;cursor:default;">Abra a aba <b>Tempo real</b> uma vez para carregar os cards — as métricas dos painéis usam exatamente esses dados em cache.</div>';

      if (!panels.length) {
        h += '<div class="cp-empty"><h3>Nenhum painel ainda</h3><p>Crie seu primeiro painel personalizado agrupando cards por etiquetas.</p>' +
          '<button class="btn" id="cp-new-2">+ Criar painel</button></div>';
      } else {
        panels.forEach(function(p) {
          var r = cachedData ? computePanel(p) : null;
          var strat = strategyOf(p);
          var open = !!p.__open;
          h += '<div class="cp-panel' + (open ? ' cp-open' : '') + '" data-id="' + p.id + '" style="--cp-color:' + p.color + '">';
          h += '<div class="cp-panel-head" data-act="toggle">';
          h += '<span class="cp-panel-swatch"></span>';
          h += '<div class="cp-panel-titlewrap"><div class="cp-panel-name">' + escHtml(p.name) + '</div>';
          h += '<div class="cp-panel-meta"><span>' + p.values.length + ' ' + (p.values.length === 1 ? strat.unit : (strat.unitPlural || strat.unit + 's')) + '</span>' +
            '<span>Atualizado ' + fmtDateTime(p.updatedAt) + '</span></div></div>';
          h += '<div class="cp-panel-count">' + (r ? r.count : '—') + ' <small>card' + (r && r.count === 1 ? '' : 's') + '</small></div>';
          h += '<div class="cp-panel-headactions">';
          h += '<button class="cp-icon-btn" data-act="config" title="Configurar painel">⚙</button>';
          h += '<button class="cp-icon-btn" data-act="dup" title="Duplicar" ' + (panels.length >= UI_LIMIT ? 'disabled' : '') + '>⧉</button>';
          h += '<button class="cp-icon-btn cp-danger" data-act="del" title="Excluir">🗑</button>';
          h += '<span class="cp-chevron">▾</span>';
          h += '</div></div>';
          if (p.values.length) {
            var filterSel = p.__filterSel || [];
            if (filterSel.length) {
              h += '<div class="cp-filter-bar">';
              h += '<div class="cp-filter-text"><span class="cp-filter-label">Filtrando por:</span>' +
                filterSel.map(function(v) { return '<b>' + escHtml(v) + '</b>'; }).join(' • ') +
                ' <span class="cp-filter-count">(' + filterSel.length + ')</span></div>';
              h += '<button class="cp-filter-clear" data-act="clearfilter">Limpar filtros</button>';
              h += '</div>';
            }
            h += '<div class="cp-labels-row">';
            p.values.forEach(function(v) {
              var sel = filterSel.indexOf(v) !== -1;
              h += '<span class="cp-label-chip' + (sel ? ' cp-label-sel' : '') + '" data-act="filterchip" data-value="' + escHtml(v) + '"><span class="cp-lc-dot"></span>' + escHtml(v) + '</span>';
            });
            h += '</div>';
          }
          h += '<div class="cp-panel-body" data-body="' + p.id + '">' + (open ? buildPanelBody(p) : '') + '</div>';
          h += '</div>';
        });
        h += buildCompare();
      }

      host.innerHTML = h;
    }

    // ══════════════ interação (delegação única) ══════════════
    function ensureTooltip() {
      if (tooltipEl) return;
      tooltipEl = document.createElement('div');
      tooltipEl.className = 'cp-tooltip';
      document.body.appendChild(tooltipEl);
    }
    function showTip(html, x, y) {
      ensureTooltip();
      tooltipEl.innerHTML = html + '<span class="cp-tt-hint">clique para ver os cards</span>';
      tooltipEl.classList.add('on');
      var w = tooltipEl.offsetWidth, h = tooltipEl.offsetHeight;
      var left = x + 14; if (left + w > window.innerWidth - 8) left = x - w - 14;
      var top = y + 14; if (top + h > window.innerHeight - 8) top = y - h - 14;
      tooltipEl.style.left = Math.max(8, left) + 'px';
      tooltipEl.style.top = Math.max(8, top) + 'px';
    }
    function hideTip() { if (tooltipEl) tooltipEl.classList.remove('on'); }

    function ensureInit() {
      if (initDone) return;
      initDone = true;
      var host = document.getElementById('custom-content');

      // clique (delegado)
      host.addEventListener('click', function(e) {
        var actEl = e.target.closest('[data-act]');
        if (actEl) {
          var panelEl = actEl.closest('.cp-panel');
          var id = panelEl ? panelEl.getAttribute('data-id') : null;
          var act = actEl.getAttribute('data-act');
          if (act === 'toggle') { togglePanel(id); return; }
          if (act === 'config') { e.stopPropagation(); openConfig(id); return; }
          if (act === 'dup') { e.stopPropagation(); duplicatePanel(id); return; }
          if (act === 'del') { e.stopPropagation(); deletePanel(id); return; }
          if (act === 'filterchip') { e.stopPropagation(); toggleFilterChip(id, actEl.getAttribute('data-value')); return; }
          if (act === 'clearfilter') { e.stopPropagation(); clearFilter(id); return; }
        }
        if (e.target.closest('#cp-refresh')) { loadRealtime(true); return; }
        if (e.target.closest('#cp-new') || e.target.closest('#cp-new-2')) { openConfig(null); return; }
        if (e.target.closest('#cp-export')) { openExport(); return; }
        var bEl = e.target.closest('[data-b]');
        if (bEl) { var b = buckets[bEl.getAttribute('data-b')]; if (b) openCards(b.title, b.cards, colorForNode(bEl)); }
      });
      // tooltip (delegado)
      host.addEventListener('mousemove', function(e) {
        var segEl = e.target.closest('.cp-seg, .cp-dot-mark, .cp-compare-row-click');
        if (!segEl) { hideTip(); return; }
        var tip = segEl.getAttribute('data-tip');
        if (!tip && segEl.classList.contains('cp-compare-row-click')) tip = 'Ver cards desta equipe';
        if (tip) showTip(tip, e.clientX, e.clientY);
      });
      host.addEventListener('mouseleave', hideTip);
    }
    function colorForNode(el) {
      var panelEl = el.closest('.cp-panel');
      if (panelEl) return panelEl.style.getPropertyValue('--cp-color') || '#0A0A0A';
      return '#0A0A0A';
    }

    // filtro rápido por etiqueta: clique alterna seleção (OR); toggle vazio = volta à visão completa.
    // 100% client-side sobre cachedData já carregado — nenhuma consulta nova ao Trello.
    function toggleFilterChip(id, value) {
      var p = byId(id); if (!p) return;
      p.__filterSel = p.__filterSel || [];
      var idx = p.__filterSel.indexOf(value);
      if (idx !== -1) p.__filterSel.splice(idx, 1); else p.__filterSel.push(value);
      draw();
    }
    function clearFilter(id) {
      var p = byId(id); if (!p) return;
      p.__filterSel = [];
      draw();
    }

    function togglePanel(id) {
      var p = byId(id); if (!p) return;
      p.__open = !p.__open;
      var panelEl = document.querySelector('.cp-panel[data-id="' + cssq(id) + '"]');
      var body = panelEl ? panelEl.querySelector('[data-body]') : null;
      if (!panelEl || !body) return;
      if (p.__open) {
        if (!body.innerHTML.trim()) body.innerHTML = buildPanelBody(p); // lazy
        panelEl.classList.add('cp-open');
      } else {
        panelEl.classList.remove('cp-open');
      }
    }

    // ══════════════ modal de configuração do painel ══════════════
    var configState = null; // { panel, isNew, saveTimer, msgTimer }
    function openConfig(id) {
      var isNew = !id;
      var panel = isNew
        ? { id: 'p' + Date.now() + '_' + Math.floor(Math.random() * 1000), name: 'Painel ' + (panels.length + 1), color: PANEL_COLORS[panels.length % PANEL_COLORS.length], criterion: 'labels', values: [], updatedAt: Date.now(), __new: true }
        : byId(id);
      if (!panel) return;
      configState = { panel: panel, isNew: isNew };
      var opts = cachedData ? strategyOf(panel).options(cachedData.cards) : [];
      var over = getOverlay();
      var sel = panel.values.slice();

      function render() {
        var strat = strategyOf(panel);
        var body = '';
        body += '<div class="cp-field"><label>Nome do painel</label>' +
          '<input class="cp-input" id="cp-cfg-name" maxlength="40" value="' + escHtml(panel.name) + '" placeholder="Ex.: Equipe Designers"></div>';
        body += '<div class="cp-field"><label>Cor de identidade</label><div class="cp-color-grid" id="cp-cfg-colors">';
        PANEL_COLORS.forEach(function(c) { body += '<span class="cp-color-dot' + (c === panel.color ? ' sel' : '') + '" data-c="' + c + '" style="background:' + c + '"></span>'; });
        body += '</div></div>';
        body += '<div class="cp-field"><label>Critério de agrupamento</label><select class="cp-input" id="cp-cfg-criterion">' +
          Object.keys(STRATEGIES).map(function(k) {
            return '<option value="' + k + '"' + (k === panel.criterion ? ' selected' : '') + '>' + escHtml(STRATEGIES[k].label) + '</option>';
          }).join('') + '</select></div>';
        body += '<div class="cp-field"><label>' + escHtml(strat.label) + ' do painel</label>';
        if (!cachedData) {
          body += '<div class="cp-cards-empty">Carregue a aba <b>Tempo real</b> para listar os valores do board.</div>';
        } else if (!opts.length) {
          body += '<div class="cp-cards-empty">Nenhum valor de ' + escHtml(strat.label.toLowerCase()) + ' encontrado nos cards.</div>';
        } else {
          body += '<input class="cp-input cp-label-search" id="cp-cfg-search" placeholder="Buscar ' + escHtml(strat.unit) + '…">';
          body += '<div class="cp-label-list" id="cp-cfg-labels"></div>';
          body += '<div class="cp-selcount" id="cp-cfg-selcount"></div>';
        }
        body += '</div>';

        var foot = '';
        if (!isNew) foot += '<button class="btn btn-secondary" data-cfg="dup">⧉ Duplicar</button>' +
          '<button class="btn btn-secondary" data-cfg="del" style="color:var(--danger-text)">🗑 Excluir</button>';
        foot += '<span class="cp-autosave" id="cp-autosave">✓ Salvo automaticamente</span>';

        setModal(over, {
          swatch: panel.color, title: escHtml(panel.name), sub: isNew ? 'Novo painel' : 'Configurar painel',
          body: body, foot: foot
        });
        wire();
        renderLabels();
      }

      function renderLabels() {
        var listEl = document.getElementById('cp-cfg-labels');
        if (!listEl) return;
        var q = (document.getElementById('cp-cfg-search') || {}).value || '';
        q = q.trim().toLowerCase();
        var html = '';
        opts.forEach(function(o) {
          if (q && o.value.toLowerCase().indexOf(q) === -1) return;
          var on = sel.indexOf(o.value) !== -1;
          html += '<label class="cp-label-opt"><input type="checkbox" data-v="' + escHtml(o.value) + '"' + (on ? ' checked' : '') + '>' +
            '<span class="cp-lo-dot" style="background:' + panel.color + '"></span>' +
            '<span class="cp-lo-name">' + escHtml(o.value) + '</span><span class="cp-lo-count">' + o.count + '</span></label>';
        });
        listEl.innerHTML = html || '<div class="cp-cards-empty">Nenhum valor corresponde à busca.</div>';
        var sc = document.getElementById('cp-cfg-selcount');
        if (sc) sc.textContent = sel.length + ' valor(es) selecionado(s) · card com vários valores conta uma vez.';
      }

      function commit() {
        panel.values = sel.slice();
        panel.updatedAt = Date.now();
        if (panel.__filterSel) panel.__filterSel = panel.__filterSel.filter(function(v) { return sel.indexOf(v) !== -1; });
        if (panel.__new) { delete panel.__new; panels.push(panel); configState.isNew = isNew = false; }
        persist();
        flashSaved();
        draw();
        // atualiza cabeçalho do modal
        var tEl = over.querySelector('.cp-modal-title'); if (tEl) tEl.textContent = panel.name;
        var swEl = over.querySelector('.cp-mh-swatch'); if (swEl) swEl.style.background = panel.color;
        var subEl = over.querySelector('.cp-modal-sub'); if (subEl) subEl.textContent = 'Configurar painel';
      }
      var commitDeb = debounce(commit, 350);
      function flashSaved() { var a = document.getElementById('cp-autosave'); if (a) { a.classList.add('on'); clearTimeout(configState.msgTimer); configState.msgTimer = setTimeout(function() { a.classList.remove('on'); }, 1400); } }

      function wire() {
        var nameEl = document.getElementById('cp-cfg-name');
        if (nameEl) nameEl.addEventListener('input', function() {
          panel.name = nameEl.value.trim() || 'Painel';
          commitDeb();
        });
        var colorsEl = document.getElementById('cp-cfg-colors');
        if (colorsEl) colorsEl.addEventListener('click', function(e) {
          var dot = e.target.closest('.cp-color-dot'); if (!dot) return;
          panel.color = dot.getAttribute('data-c');
          colorsEl.querySelectorAll('.cp-color-dot').forEach(function(d) { d.classList.toggle('sel', d === dot); });
          document.querySelectorAll('#cp-cfg-labels .cp-lo-dot').forEach(function(d) { d.style.background = panel.color; });
          commit();
        });
        var criterionEl = document.getElementById('cp-cfg-criterion');
        if (criterionEl) criterionEl.addEventListener('change', function() {
          panel.criterion = criterionEl.value;
          sel = [];
          panel.__filterSel = [];
          opts = cachedData ? strategyOf(panel).options(cachedData.cards) : [];
          commit();
          render();
        });
        var searchEl = document.getElementById('cp-cfg-search');
        if (searchEl) searchEl.addEventListener('input', renderLabels);
        var labelsEl = document.getElementById('cp-cfg-labels');
        if (labelsEl) labelsEl.addEventListener('change', function(e) {
          var cb = e.target.closest('input[type=checkbox]'); if (!cb) return;
          var v = cb.getAttribute('data-v');
          var idx = sel.indexOf(v);
          if (cb.checked && idx === -1) sel.push(v);
          else if (!cb.checked && idx !== -1) sel.splice(idx, 1);
          var sc = document.getElementById('cp-cfg-selcount');
          if (sc) sc.textContent = sel.length + ' valor(es) selecionado(s) · card com vários valores conta uma vez.';
          commitDeb();
        });
        over.querySelectorAll('[data-cfg]').forEach(function(b) {
          b.addEventListener('click', function() {
            var a = b.getAttribute('data-cfg');
            if (a === 'dup') { closeOverlay(over); duplicatePanel(panel.id); }
            if (a === 'del') { closeOverlay(over); deletePanel(panel.id); }
          });
        });
      }

      showOverlay(over);
      render();
      var ni = document.getElementById('cp-cfg-name'); if (ni && isNew) { ni.focus(); ni.select(); }
    }

    function duplicatePanel(id) {
      if (panels.length >= UI_LIMIT) { t.alert({ message: 'Limite de ' + UI_LIMIT + ' painéis atingido.', display: 'warning', duration: 4 }); return; }
      var p = byId(id); if (!p) return;
      var copy = { id: 'p' + Date.now() + '_' + Math.floor(Math.random() * 1000), name: p.name + ' (cópia)', color: p.color, criterion: p.criterion, values: p.values.slice(), updatedAt: Date.now() };
      var idx = panels.indexOf(p);
      panels.splice(idx + 1, 0, copy);
      persist(); draw();
    }
    function deletePanel(id) {
      var p = byId(id); if (!p) return;
      if (!window.confirm('Excluir o painel "' + p.name + '"? Esta ação não pode ser desfeita.')) return;
      panels = panels.filter(function(x) { return x.id !== id; });
      persist(); draw();
    }

    // ══════════════ modal de detalhes dos cards (busca/ordenação/scroll virtual) ══════════════
    function openCards(title, cards, color, opts) {
      opts = opts || {};
      var over = getOverlay('cp-modal-lg');
      var state = { q: '', sort: 'name', list: cards.slice() };
      var ROW_H = 48;

      function apply() {
        var arr = cards.slice();
        if (state.q) { var q = state.q.toLowerCase(); arr = arr.filter(function(c) { return (c.name || '').toLowerCase().indexOf(q) !== -1 || (c.labels || []).join(' ').toLowerCase().indexOf(q) !== -1; }); }
        arr.sort(function(a, b) {
          if (state.sort === 'name') return (a.name || '').localeCompare(b.name || '');
          if (state.sort === 'rw') return (b.retrabalho || 0) - (a.retrabalho || 0);
          if (state.sort === 'pe') return ((b.primeiraEntrega ? b.primeiraEntrega.horas : -1)) - ((a.primeiraEntrega ? a.primeiraEntrega.horas : -1));
          if (state.sort === 'list') return (a.currentListName || '').localeCompare(b.currentListName || '');
          return 0;
        });
        state.list = arr;
        renderRows();
        var cnt = document.getElementById('cp-cards-count'); if (cnt) cnt.textContent = arr.length + ' de ' + cards.length + ' card(s)';
      }
      function rowHtml(c, top) {
        var clienteTxt = (c.labels || []).length ? (c.labels || []).join(', ') : '—';
        var respTxt = (c.members || []).length ? (c.members || []).join(', ') : '—';
        var nivel = c.nivelEsforco ? '<span class="cp-tagmini cp-nivel" style="background:' + (nivelCor(color)[c.nivelEsforco] || color) + '">' + c.nivelEsforco + '</span>' : '<span class="cp-cell-muted">—</span>';
        var rw = c.retrabalho > 0 ? '<span class="cp-tagmini cp-rw">↻ ' + c.retrabalho + '</span>' : '<span class="cp-cell-muted">—</span>';
        var peTxt = c.primeiraEntrega ? fmtHoras(c.primeiraEntrega.horas) : '—';
        return '<div class="cp-crow" style="top:' + top + 'px" data-card="' + escHtml(c.id) + '" title="' + escHtml(c.name || '') + '">' +
          '<span class="cp-crow-cell cp-crow-name">' + escHtml(c.name || '(sem título)') + '</span>' +
          '<span class="cp-crow-cell" title="' + escHtml(clienteTxt) + '">' + escHtml(clienteTxt) + '</span>' +
          '<span class="cp-crow-cell" title="' + escHtml(respTxt) + '">' + escHtml(respTxt) + '</span>' +
          '<span class="cp-crow-cell cp-crow-center">' + nivel + '</span>' +
          '<span class="cp-crow-cell cp-crow-center">' + escHtml(peTxt) + '</span>' +
          '<span class="cp-crow-cell cp-crow-center">' + rw + '</span>' +
          '<span class="cp-crow-cell" title="' + escHtml(c.currentListName || '') + '">' + escHtml(c.currentListName || '—') + '</span>' +
          '</div>';
      }
      var vport, inner;
      function renderRows() {
        if (!vport) return;
        var n = state.list.length;
        inner.style.height = n * ROW_H + 'px';
        var scrollTop = vport.scrollTop, vh = vport.clientHeight;
        var start = Math.max(0, Math.floor(scrollTop / ROW_H) - 4);
        var end = Math.min(n, Math.ceil((scrollTop + vh) / ROW_H) + 4);
        var html = '';
        for (var i = start; i < end; i++) html += rowHtml(state.list[i], i * ROW_H);
        inner.innerHTML = html || '<div class="cp-cards-empty">Nenhum card corresponde à busca.</div>';
      }

      var body = '<div class="cp-cards-controls">' +
        '<input class="cp-input" id="cp-cards-q" placeholder="Buscar por nome ou etiqueta…">' +
        '<select id="cp-cards-sort"><option value="name">Nome (A–Z)</option><option value="rw">Mais retrabalho</option><option value="pe">Maior tempo 1ª entrega</option><option value="list">Lista atual</option></select>' +
        '</div><div class="cp-vlist" id="cp-cards-vlist">' +
        '<div class="cp-ctable-head"><span>Nome do Card</span><span>Cliente</span><span>Responsáveis</span>' +
        '<span class="cp-crow-center">Dificuldade</span><span class="cp-crow-center">1ª Entrega</span>' +
        '<span class="cp-crow-center">Retrabalhos</span><span>Lista Atual</span></div>' +
        '<div class="cp-vlist-inner" id="cp-cards-inner"></div></div>';
      var foot = '<span class="cp-modal-sub" id="cp-cards-count" style="color:var(--muted)"></span>';
      if (opts.onExport) foot += '<button class="btn btn-secondary" id="cp-cards-export" style="margin-left:auto" ' + (cards.length ? '' : 'disabled') + '>⬇ Exportar planilha</button>';

      setModal(over, { swatch: color, title: escHtml(title), sub: 'Detalhes dos cards', body: body, foot: foot });
      showOverlay(over);
      vport = document.getElementById('cp-cards-vlist');
      inner = document.getElementById('cp-cards-inner');
      vport.addEventListener('scroll', renderRows);
      document.getElementById('cp-cards-q').addEventListener('input', function() { state.q = this.value; apply(); });
      document.getElementById('cp-cards-sort').addEventListener('change', function() { state.sort = this.value; apply(); });
      inner.addEventListener('click', function(e) {
        var row = e.target.closest('[data-card]'); if (row) t.showCard(row.getAttribute('data-card'));
      });
      if (opts.onExport) {
        var expBtn = document.getElementById('cp-cards-export');
        expBtn.addEventListener('click', function() { opts.onExport(expBtn); });
      }
      apply();
    }

    // ══════════════ exportação (PNG + PDF executivo) ══════════════
    function openExport() {
      var over = getOverlay();
      var options = '<option value="__all">Relatório geral (todos os painéis)</option>';
      panels.forEach(function(p) { if (p.values.length) options += '<option value="' + p.id + '">' + escHtml(p.name) + '</option>'; });
      var body = '<div class="cp-field"><label>Escopo do relatório</label><select class="cp-input" id="cp-exp-scope">' + options + '</select></div>' +
        '<div class="cp-field"><label>Formato</label><div style="display:flex;gap:10px">' +
        '<button class="btn" id="cp-exp-png" style="flex:1">🖼 PNG</button>' +
        '<button class="btn" id="cp-exp-pdf" style="flex:1">📄 PDF</button></div></div>' +
        '<p style="font-size:11px;color:var(--muted)">Relatório executivo pronto para apresentação: logo, KPIs, gráficos e comparativo.</p>';
      setModal(over, { swatch: '#FFCF06', title: 'Exportar relatório', sub: 'Análises Personalizadas', body: body, foot: '<span class="cp-modal-sub" id="cp-exp-status" style="color:var(--muted)"></span>' });
      showOverlay(over);
      document.getElementById('cp-exp-png').addEventListener('click', function() { runExport(document.getElementById('cp-exp-scope').value, 'png', this); });
      document.getElementById('cp-exp-pdf').addEventListener('click', function() { runExport(document.getElementById('cp-exp-scope').value, 'pdf', this); });
    }

    function buildReportNode(scope) {
      var wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;left:-99999px;top:0;width:1040px;background:#F6F6F7;' +
        "font-family:'BW Modelica','Inter','Helvetica Neue',sans-serif;color:#0A0A0A;padding:34px;box-sizing:border-box;";
      var agora = fmtDateTime(new Date());
      var scopePanels = scope === '__all' ? panels.filter(function(p) { return p.values.length; }) : [byId(scope)].filter(Boolean);
      var titulo = scope === '__all' ? 'Relatório de Análises Personalizadas' : scopePanels[0].name;
      var h = '';
      // cabeçalho / logo
      h += '<div style="display:flex;align-items:center;justify-content:space-between;background:#0A0A0A;border-radius:14px;padding:22px 26px;margin-bottom:20px;">';
      h += '<div><div style="font-size:22px;font-weight:800;letter-spacing:-0.01em;color:#FFCF06;">Power Up Midiática</div>' +
        '<div style="font-size:13px;color:#A2A2AA;margin-top:2px;">' + escHtml(titulo) + '</div></div>';
      h += '<div style="text-align:right;font-size:12px;color:#A2A2AA;">Gerado em ' + agora + '<br>Período: dados a partir de ' + fmtDateBR(PRIMEIRA_ENTREGA_EPOCH) + '</div></div>';

      scopePanels.forEach(function(p) {
        var r = computePanel(p);
        h += '<div style="background:#fff;border:1px solid #E8E8EC;border-top:3px solid ' + p.color + ';border-radius:14px;padding:22px;margin-bottom:18px;">';
        h += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">' +
          '<span style="width:14px;height:14px;border-radius:4px;background:' + p.color + ';"></span>' +
          '<div style="font-size:18px;font-weight:700;">' + escHtml(p.name) + '</div>' +
          '<div style="margin-left:auto;font-size:13px;color:#75757F;">' + r.count + ' atividades · ' + p.values.length + ' etiquetas</div></div>';
        // KPIs
        var kpis = [
          ['Concluídas', r.nConcluidas], ['Retrabalhos', r.retrabalhos], ['Eficiência', pct1(r.eficiencia)],
          ['% retrabalho', pct1(r.pctRetrabalho)], ['Tempo médio', fmtHoras(r.tempoMedio)], ['Participação', pct1(r.participacao)]
        ];
        h += '<div style="display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:16px;">';
        kpis.forEach(function(k) {
          h += '<div style="background:#FBFBFC;border:1px solid #E8E8EC;border-radius:10px;padding:12px;">' +
            '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#75757F;margin-bottom:6px;">' + k[0] + '</div>' +
            '<div style="font-size:20px;font-weight:700;">' + k[1] + '</div></div>';
        });
        h += '</div>';
        // gráficos (2 por linha)
        h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">';
        h += '<div style="border:1px solid #E8E8EC;border-radius:12px;padding:14px;"><div style="font-size:12px;font-weight:700;margin-bottom:8px;">Atividades concluídas</div>' + chartConcluidas(r) + '</div>';
        h += '<div style="border:1px solid #E8E8EC;border-radius:12px;padding:14px;"><div style="font-size:12px;font-weight:700;margin-bottom:8px;">Retrabalhos</div>' + chartRetrabalho(r) + '</div>';
        h += '<div style="border:1px solid #E8E8EC;border-radius:12px;padding:14px;"><div style="font-size:12px;font-weight:700;margin-bottom:8px;">Tempo até 1ª entrega</div>' + chartTempoEntrega(r) + '</div>';
        h += '<div style="border:1px solid #E8E8EC;border-radius:12px;padding:14px;"><div style="font-size:12px;font-weight:700;margin-bottom:8px;">Quantidade por dificuldade</div>' + chartQtdeDificuldade(r) + '</div>';
        h += '<div style="grid-column:1/-1;border:1px solid #E8E8EC;border-radius:12px;padding:14px;"><div style="font-size:12px;font-weight:700;margin-bottom:8px;">Evolução no período</div>' + chartEvolucao(r) + '</div>';
        h += '</div></div>';
      });

      if (scope === '__all') { var cmp = buildCompare(); if (cmp) h += '<div style="background:#fff;border:1px solid #E8E8EC;border-radius:14px;padding:22px;margin-bottom:18px;">' + cmp + '</div>'; }
      h += '<div style="font-size:11px;color:#75757F;text-align:center;margin-top:8px;">Power Up Midiática · relatório gerado automaticamente em ' + agora + ' · métricas idênticas às do dashboard</div>';
      wrap.innerHTML = h;
      return wrap;
    }

    function runExport(scope, format, btn) {
      var status = document.getElementById('cp-exp-status');
      if (status) status.textContent = 'Gerando…';
      setBtnLoading(btn, true);
      loadHtml2Canvas(function(err) {
        if (err || typeof html2canvas === 'undefined') { if (status) status.textContent = 'Falha ao carregar o gerador.'; setBtnLoading(btn, false); return; }
        var node = buildReportNode(scope);
        document.body.appendChild(node);
        html2canvas(node, { scale: 2, backgroundColor: '#F6F6F7', logging: false, useCORS: true }).then(function(canvas) {
          if (format === 'png') { downloadCanvas(canvas, 'analise_midiatica'); finish(); return; }
          loadJsPDF(function(e2) {
            if (e2 || !window.jspdf) { downloadCanvas(canvas, 'analise_midiatica'); finish('PDF indisponível — exportado como imagem.'); return; }
            try {
              var jsPDF = window.jspdf.jsPDF;
              var pdf = new jsPDF('p', 'mm', 'a4');
              var pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
              var imgW = pw, imgH = canvas.height * imgW / canvas.width;
              var img = canvas.toDataURL('image/jpeg', 0.92);
              var y = 0;
              if (imgH <= ph) { pdf.addImage(img, 'JPEG', 0, 0, imgW, imgH); }
              else {
                var remaining = imgH;
                while (remaining > 0) { pdf.addImage(img, 'JPEG', 0, y, imgW, imgH); remaining -= ph; if (remaining > 0) { pdf.addPage(); y -= ph; } }
              }
              pdf.save('analise_midiatica.pdf');
              finish();
            } catch (ex) { downloadCanvas(canvas, 'analise_midiatica'); finish('Falha no PDF — exportado como imagem.'); }
          });
        }).catch(function() { finish('Falha ao gerar o relatório.'); });
        function finish(msg) {
          if (node.parentNode) node.parentNode.removeChild(node);
          setBtnLoading(btn, false);
          if (status) status.textContent = msg || 'Concluído!';
        }
      });
    }

    // ══════════════ overlays (helpers) ══════════════
    function getOverlay(modalClass) {
      var over = document.createElement('div');
      over.className = 'cp-overlay';
      over.innerHTML = '<div class="cp-modal ' + (modalClass || '') + '"></div>';
      over.addEventListener('click', function(e) { if (e.target === over) closeOverlay(over); });
      document.body.appendChild(over);
      return over;
    }
    function setModal(over, o) {
      var m = over.querySelector('.cp-modal');
      m.innerHTML =
        '<div class="cp-modal-head">' + (o.swatch ? '<span class="cp-mh-swatch" style="background:' + o.swatch + '"></span>' : '') +
        '<div style="flex:1;min-width:0"><div class="cp-modal-title">' + o.title + '</div>' + (o.sub ? '<div class="cp-modal-sub">' + o.sub + '</div>' : '') + '</div>' +
        '<button class="cp-modal-close" aria-label="Fechar">&times;</button></div>' +
        '<div class="cp-modal-body">' + o.body + '</div>' +
        (o.foot ? '<div class="cp-modal-foot">' + o.foot + '</div>' : '');
      m.querySelector('.cp-modal-close').addEventListener('click', function() { closeOverlay(over); });
    }
    function showOverlay(over) { requestAnimationFrame(function() { over.classList.add('on'); }); }
    function closeOverlay(over) {
      over.classList.remove('on');
      setTimeout(function() { if (over.parentNode) over.parentNode.removeChild(over); }, 180);
      hideTip();
    }

    // ── util ──
    function byId(id) { for (var i = 0; i < panels.length; i++) if (panels[i].id === id) return panels[i]; return null; }
    function cssq(s) { return String(s).replace(/"/g, '\\"'); }

    // ══════════════ API pública ══════════════
    return {
      render: function() {
        ensureInit();
        if (!loaded) {
          document.getElementById('custom-content').innerHTML = '<div class="spinner-wrap"><div class="spinner"></div><p>Carregando painéis…</p></div>';
          load().then(draw);
        } else {
          draw();
        }
      },
      // exposto para outras abas (ex.: Detalhamento) reutilizarem o mesmo modal de cards,
      // em vez de duplicar o componente — mantém aparência/comportamento 100% consistentes.
      openCards: openCards,
      // Modal genérico (mesma casca/animação do modal de cards) + gráfico de linha —
      // expostos para a aba Histórico montar seu drill-down SEM duplicar componente.
      // Retorna o overlay para o chamador conectar handlers internos.
      openModal: function(o) {
        var over = getOverlay(o && o.size === 'lg' ? 'cp-modal-lg' : '');
        setModal(over, {
          swatch: o.color, title: escHtml(o.title || ''), sub: o.sub || '',
          body: o.body || '', foot: o.foot || ''
        });
        showOverlay(over);
        return over;
      },
      lineChart: lineChart,
      emptyChart: emptyChart
    };
  })();

  return CP;
}
