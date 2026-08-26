// ==========================================================================
//  Formatacao para exibicao (pt-BR) e escape de HTML.
// ==========================================================================

import { round1 } from './core-util.js';

// elemento único reutilizado (antes: um <span> novo por chamada, milhares em tabelas grandes)
var _escEl = document.createElement('span');
export function escHtml(s) { _escEl.textContent = s; return _escEl.innerHTML; }

export function fmtDateTime(d) {
  d = new Date(d);
  function p(n){ return String(n).padStart(2,'0'); }
  return p(d.getDate())+'/'+p(d.getMonth()+1)+'/'+d.getFullYear()+' '+p(d.getHours())+':'+p(d.getMinutes());
}

export function fmtDateBR(d) {
  d = new Date(d);
  function p(n){ return String(n).padStart(2,'0'); }
  return p(d.getDate())+'/'+p(d.getMonth()+1)+'/'+d.getFullYear();
}

export function fmtHoras(h) { return String(h).replace('.', ',') + 'h'; }
export function fmtDias(d)  { return String(d).replace('.', ',') + ' d.u.'; }
export function fmtPct(p)   { return String(round1(p)).replace('.', ',') + '%'; }
