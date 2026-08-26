// ==========================================================================
//  Motor de tempo: dias/horas uteis, jornada de trabalho e timeline do card.
//  
//  countBusinessDays e buildTimeline sao compartilhados com index.html — eram
//  copias byte-identicas nos dois arquivos.
// ==========================================================================

import { MIN_STAGE_MS } from './config.js';
import { round1 } from './core-util.js';

export function countBusinessDays(from, to) {
  var s = new Date(from); s.setHours(0,0,0,0);
  var e = new Date(to);   e.setHours(0,0,0,0);
  var totalDays = Math.round((e - s) / 86400000);
  if (totalDays <= 0) return 0;
  var weeks = Math.floor(totalDays / 7);
  var remainder = totalDays % 7;
  var count = weeks * 5;
  var dayOfWeek = s.getDay();
  for (var i = 0; i < remainder; i++) {
    var d = (dayOfWeek + i) % 7;
    if (d !== 0 && d !== 6) count++;
  }
  return count;
}

// ─── TEMPO: DIAS/HORAS CORRIDAS E HORAS ÚTEIS ───
// Jornada de trabalho considerada para "horas úteis" (seg–sex, fuso local).
export var WORK_START_HOUR = 9;   // 09:00
export var WORK_END_HOUR   = 18;  // 18:00 → 9h úteis/dia
export function elapsedCalendarDays(from, to) { return round1((new Date(to) - new Date(from)) / 86400000); }
export function elapsedCalendarHours(from, to) { return round1((new Date(to) - new Date(from)) / 3600000); }

// Horas úteis entre duas datas (SEM arredondar): soma a sobreposição com a janela
// de trabalho de cada dia útil. Itera dia a dia (O(nº de dias)) — barato mesmo para
// etapas longas. A versão raw é usada para o breakdown FECHAR com o total (somar
// valores já arredondados por etapa introduz drift; somamos raw e arredondamos 1x).
export function businessHoursRaw(from, to) {
  from = new Date(from); to = new Date(to);
  if (to <= from) return 0;
  var total = 0;
  var cursor = new Date(from); cursor.setHours(0,0,0,0);
  while (cursor <= to) {
    var dow = cursor.getDay();
    if (dow !== 0 && dow !== 6) { // seg–sex
      var dayStart = new Date(cursor); dayStart.setHours(WORK_START_HOUR,0,0,0);
      var dayEnd   = new Date(cursor); dayEnd.setHours(WORK_END_HOUR,0,0,0);
      var s = from > dayStart ? from : dayStart;
      var e = to   < dayEnd   ? to   : dayEnd;
      if (e > s) total += (e - s) / 3600000;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return total;
}
export function countBusinessHours(from, to) { return round1(businessHoursRaw(from, to)); }

// Data de criação embutida no ID do card do Trello: os 4 primeiros bytes (8 hex)
// são o timestamp Unix em segundos. Permite filtrar arquivados por data de criação
// ANTES de buscar as actions deles (barra o histórico antigo sem custo de fetch).
export function idToDate(id) {
  if (!id || id.length < 8) return null;
  var secs = parseInt(id.substring(0, 8), 16);
  if (isNaN(secs)) return null;
  return new Date(secs * 1000);
}

export function buildTimeline(actions) {
  if (!Array.isArray(actions)) actions = [];
  actions.sort(function(a, b) {
    var diff = new Date(a.date) - new Date(b.date);
    if (diff !== 0) return diff;
    var priority = { createCard: 0, copyCard: 0, updateCard: 1 };
    return (priority[a.type] || 2) - (priority[b.type] || 2);
  });

  var createdAt = null;
  for (var k = 0; k < actions.length; k++) {
    if (actions[k].type === 'createCard' || actions[k].type === 'copyCard') {
      createdAt = new Date(actions[k].date);
      break;
    }
  }
  if (!createdAt && actions.length > 0) {
    createdAt = new Date(actions[0].date);
  }

  var stages = [];
  for (var i = 0; i < actions.length; i++) {
    var act = actions[i], date = new Date(act.date);
    if (createdAt && date < createdAt) continue;
    if ((act.type === 'createCard' || act.type === 'copyCard') && act.data.list) {
      if (stages.length === 0) {
        stages.push({ name: act.data.list.name, enteredAt: date, leftAt: null });
      }
    } else if (act.type === 'updateCard' && act.data.listAfter) {
      if (stages.length === 0 && act.data.listBefore) {
        var fallback = createdAt || date;
        stages.push({ name: act.data.listBefore.name, enteredAt: fallback, leftAt: date });
      }
      if (stages.length > 0) stages[stages.length - 1].leftAt = date;
      stages.push({ name: act.data.listAfter.name, enteredAt: date, leftAt: null });
    }
  }

  if (stages.length > 0) {
    for (var v = 0; v < stages.length; v++) {
      if (createdAt && stages[v].enteredAt < createdAt) {
        stages[v].enteredAt = createdAt;
      }
    }
  }

  var out = [];
  for (var j = 0; j < stages.length; j++) {
    var st = stages[j];
    var dur = (st.leftAt ? st.leftAt.getTime() : Date.now()) - st.enteredAt.getTime();
    if (dur < MIN_STAGE_MS && st.leftAt && out.length > 0) {
      out[out.length - 1].leftAt = st.leftAt;
    } else {
      out.push(st);
    }
  }

  if (out.length === 1 && !out[0].leftAt && createdAt) {
    out[0].enteredAt = createdAt;
  }

  return out;
}

// ─── UTILITÁRIOS DE DATA (reutilizáveis) ────────
// Centralizam a comparação de datas para que vencidos, vazão e lead time usem
// exatamente a mesma interpretação (mesmo "hoje", mesmo conceito de mês).
export function startOfToday() { var d = new Date(); d.setHours(0,0,0,0); return d; }

// Card vencido = tem due, NÃO está marcado como concluído (dueComplete) e a data
// de entrega já passou (compara dias no fuso local, ignorando horas). Excluir
// dueComplete evita falso-positivo de card já entregue ainda contar como atrasado.
export function isOverdue(due, dueComplete) {
  if (!due || dueComplete === true) return false;
  var d = new Date(due); d.setHours(0,0,0,0);
  return d < startOfToday();
}

// Mesma competência (mês+ano) entre duas datas — base do recorte mensal da vazão.
export function sameMonth(date, ref) {
  return date.getMonth() === ref.getMonth() && date.getFullYear() === ref.getFullYear();
}
