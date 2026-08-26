// ==========================================================================
//  Utilitarios genericos: debounce, arredondamento e estatistica.
// ==========================================================================

export function debounce(fn, delay) {
  var timer;
  return function() {
    clearTimeout(timer);
    var args = arguments, ctx = this;
    timer = setTimeout(function() { fn.apply(ctx, args); }, delay);
  };
}

export function round1(x) { return Math.round(x * 10) / 10; }

// Desvio padrão populacional (volatilidade) de um array de números.
export function stdDev(arr) {
  if (!arr || arr.length < 2) return 0;
  var m = arr.reduce(function(a,b){return a+b;},0) / arr.length;
  var v = arr.reduce(function(a,b){return a+(b-m)*(b-m);},0) / arr.length;
  return round1(Math.sqrt(v));
}
export function mean(arr) {
  if (!arr || !arr.length) return 0;
  return round1(arr.reduce(function(a,b){return a+b;},0) / arr.length);
}
// Mediana (resistente a outliers) — aditiva; não altera nenhum KPI existente.
export function median(arr) {
  if (!arr || !arr.length) return 0;
  var s = arr.slice().sort(function(a,b){ return a-b; });
  var m = Math.floor(s.length / 2);
  return round1(s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2);
}

export function validarTitulo(nome) {
  return typeof nome === 'string' && nome.trim().length > 0;
}
