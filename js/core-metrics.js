// ==========================================================================
//  Metricas de dominio derivadas da timeline: conclusao, lead time e 1a entrega.
// ==========================================================================

import { PRODUCAO_ATIVA, MARCOS_ENTREGA, ETAPAS_PRE_ENTREGA, EM_ANDAMENTO } from './config.js';
import { countBusinessDays, businessHoursRaw } from './core-time.js';
import { round1 } from './core-util.js';

// ─── CONCLUSÃO & LEAD TIME ──────────────────────
// Data em que o card entrou pela ÚLTIMA vez em "Concluído 🏆" (ou null).
// Usar a timeline (e não o flag dueComplete + due date) torna a métrica robusta a
// cards reabertos (pega a última conclusão) e a cards sem due date.
export function getConcludedAt(tl) {
  if (!Array.isArray(tl)) return null;
  var concludedAt = null;
  for (var i = 0; i < tl.length; i++) {
    var name = tl[i].name ? tl[i].name.trim() : '';
    if (name === 'Concluído 🏆') concludedAt = tl[i].enteredAt; // última vence
  }
  return concludedAt;
}

// Lead time real (atravessamento do fluxo), em dias úteis:
//   início = primeira entrada numa etapa de PRODUÇÃO ATIVA (saiu do backlog)
//   fim    = conclusão (getConcludedAt)
// Retorna { leadTime, concludedAt } ou null se não atravessou o fluxo
// (nunca foi produzido, ou ainda não concluído).
export function computeLeadTime(tl, concludedAt) {
  if (!Array.isArray(tl) || !tl.length) return null;
  var startProd = null;
  for (var i = 0; i < tl.length; i++) {
    var name = tl[i].name ? tl[i].name.trim() : '';
    if (PRODUCAO_ATIVA.indexOf(name) !== -1) { startProd = tl[i].enteredAt; break; }
  }
  if (concludedAt === undefined) concludedAt = getConcludedAt(tl); // reaproveita se já calculado
  if (!startProd || !concludedAt || concludedAt <= startProd) return null;
  return { leadTime: countBusinessDays(startProd, concludedAt), concludedAt: concludedAt };
}

// Normaliza o texto do "Nível de Esforço" para um dos buckets (BAIXO/MÉDIO/ALTO/MUITO ALTO).
// Tolerante a acentos e caixa: "Médio", "medio", "MEDIO" → "MÉDIO".
export function normalizeNivel(text) {
  if (!text) return null;
  var t = String(text).trim().toUpperCase()
    .replace(/[ÁÀÂÃÄ]/g,'A').replace(/[ÉÈÊË]/g,'E').replace(/[ÍÌÎÏ]/g,'I')
    .replace(/[ÓÒÔÕÖ]/g,'O').replace(/[ÚÙÛÜ]/g,'U');
  if (t.indexOf('BAIX')  === 0) return 'BAIXO';
  if (t.indexOf('MED')   === 0) return 'MÉDIO';
  if (t.indexOf('MUITO') === 0) return 'MUITO ALTO';
  if (t.indexOf('ALT')   === 0) return 'ALTO';
  return null;
}

// ─── TEMPO ATÉ PRIMEIRA ENTREGA ─────────────────
// Da CRIAÇÃO do card até a 1ª CHEGADA a um marco de entrega (Revisão Externa 🧐 ou
// Concluído 🏆).
//   início = tl[0].enteredAt (createdAt, já clampado pela buildTimeline)
//   fim    = enteredAt do PRIMEIRO estágio cujo nome ∈ MARCOS_ENTREGA
// Retorna null se o card ainda não atingiu um marco de entrega.
// Usar a CHEGADA ao marco (e não a saída de Revisão Interna) é robusto a reprovações
// internas que voltam para retrabalho (não param o cronômetro) e a cards que pulam a
// revisão interna. Também conta reentradas em "Em andamento" no percurso
// (1 = original, 2+ = retrabalho).
//
// Breakdown: os estágios 0..idxFim-1 PARTICIONAM [início, fim] (contíguos, sem
// gaps). Cada etapa nomeada acumula suas horas úteis; o restante (URGÊNCIAS,
// Captação, Atrasos, …) cai em "Outras etapas". Somamos horas RAW e a headline é a
// soma dos buckets já arredondados → o breakdown FECHA exatamente com o total.
export function computePrimeiraEntrega(tl) {
  if (!Array.isArray(tl) || !tl.length) return null;
  var inicio = tl[0].enteredAt;
  var fim = null, idxFim = -1;
  for (var i = 0; i < tl.length; i++) {
    if (MARCOS_ENTREGA.indexOf(tl[i].name ? tl[i].name.trim() : '') !== -1) {
      fim = tl[i].enteredAt; idxFim = i; break; // 1ª CHEGADA a um marco de entrega
    }
  }
  if (!fim || fim <= inicio) return null;

  var breakdown = {};
  ETAPAS_PRE_ENTREGA.forEach(function(n){ breakdown[n] = 0; });
  var entradasEmAndamento = 0;
  for (var j = 0; j < idxFim; j++) { // estágios ANTES do marco (particionam [início,fim])
    var nome = tl[j].name ? tl[j].name.trim() : '';
    var fimEtapa = tl[j].leftAt || fim; // o último pré-marco fecha em `fim`
    var horasEtapa = businessHoursRaw(tl[j].enteredAt, fimEtapa);
    if (breakdown.hasOwnProperty(nome)) breakdown[nome] += horasEtapa;
    else breakdown['Outras etapas'] += horasEtapa;
    if (nome === EM_ANDAMENTO) entradasEmAndamento++;
  }
  ETAPAS_PRE_ENTREGA.forEach(function(n){ breakdown[n] = round1(breakdown[n]); });

  // headline = soma dos buckets já arredondados → fecha com a soma exibida no breakdown.
  var horas = 0;
  ETAPAS_PRE_ENTREGA.forEach(function(n){ horas += breakdown[n]; });
  horas = round1(horas);

  return {
    inicio: inicio,
    horas: horas,
    dias: countBusinessDays(inicio, fim),
    breakdown: breakdown,
    entradasEmAndamento: entradasEmAndamento
  };
}
