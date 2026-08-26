// ==========================================================================
//  Entrada/saida do browser: download de arquivos e carga sob demanda de libs.
// ==========================================================================

export function downloadCSV(filename, rows) {
  var csv = rows.map(function(row) {
    return row.map(function(cell) {
      // {raw: '...'} pula o escape de fórmula (usado pelo =HYPERLINK intencional)
      var isRaw = cell && typeof cell === 'object' && cell.raw !== undefined;
      var s = String(isRaw ? cell.raw : (cell === null || cell === undefined ? '' : cell));
      // anti formula-injection: célula iniciando com = + - @ vira texto no Excel
      if (!isRaw && /^[=+\-@]/.test(s)) s = "'" + s;
      if (s.indexOf(';') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
        s = '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    }).join(';');
  }).join('\r\n');
  var bom = '﻿';
  var blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
}

// ─── CARREGAMENTO PREGUIÇOSO DE LIBS (on-demand) ─
// Carregadas só ao clicar em exportar → zero impacto na renderização em tempo real.
export function loadScriptOnce(src, globalName, cb) {
  if (window[globalName]) return cb();
  var s = document.createElement('script');
  s.src = src;
  s.onload = function() { cb(); };
  s.onerror = function() { cb(new Error('Falha ao carregar ' + src)); };
  document.head.appendChild(s);
}
export function loadXLSXLib(cb) {
  loadScriptOnce('https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js', 'XLSX', cb);
}
export function loadHtml2Canvas(cb) {
  loadScriptOnce('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js', 'html2canvas', cb);
}

export function loadJsPDF(cb) {
  loadScriptOnce('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js', 'jspdf', cb);
}

// ─── FEEDBACK DE LOADING NOS BOTÕES (reutilizável) ─
export function setBtnLoading(btn, on) {
  if (!btn) return;
  if (on) {
    btn.disabled = true;
    btn.dataset.label = btn.textContent;
    btn.textContent = '⏳ Exportando…';
  } else {
    btn.disabled = false;
    if (btn.dataset.label) btn.textContent = btn.dataset.label;
  }
}

export function downloadCanvas(canvas, base) {
  // WEBP: menor que PNG e nítido como ele; se o browser não codificar WEBP, cai p/ PNG.
  canvas.toBlob(function(blob) {
    if (blob && blob.type === 'image/webp') { triggerDownload(blob, base + '.webp'); return; }
    canvas.toBlob(function(png) { if (png) triggerDownload(png, base + '.png'); }, 'image/png');
  }, 'image/webp', 0.92);
}
export function triggerDownload(blob, filename) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
}
