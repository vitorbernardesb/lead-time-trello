// ==========================================================================
//  Constantes de dominio: etapas do fluxo, marcos, niveis e metas padrao.
//  
//  Sem dependencias — e a base da qual todo o resto deriva.
// ==========================================================================

// Etapas com permanência menor que isto são fundidas na etapa anterior
// (mantém badge, seção do card e dashboard consistentes).
export var MIN_STAGE_MS = 600000;

export var FLOW_LISTS = [
  'Planejamento',
  'Captação de Imagem 🎥',
  '🛑URGÊNCIAS🛑',
  'A fazer 👇',
  'Em andamento 💪',
  'Alterações ✏️',
  '⚠️Atrasos⚠️',
  'Revisão Interna 🔎',
  'Revisão Externa 🧐',
  'Revisões em Atraso ⏰',
  'Concluído 🏆'
];

export var PRODUCAO_ATIVA = [
  'Captação de Imagem 🎥',
  '🛑URGÊNCIAS🛑',
  'A fazer 👇',
  'Em andamento 💪',
  'Alterações ✏️',
  '⚠️Atrasos⚠️',
  'Revisão Interna 🔎',
  'Revisão Externa 🧐',
  'Revisões em Atraso ⏰'
];

// ─── TEMPO ATÉ PRIMEIRA ENTREGA (por Nível de Esforço) ─
export var EM_ANDAMENTO    = 'Em andamento 💪';
// "Entrega" = 1ª CHEGADA a um marco de entrega (revisão externa ou concluído).
// Usar a CHEGADA (e não a saída de Revisão Interna) evita parar o cronômetro em
// reprovações internas que voltam para retrabalho e captura cards que pulam a
// revisão interna. Ver computePrimeiraEntrega.
export var MARCOS_ENTREGA = ['Revisão Externa 🧐', 'Concluído 🏆'];
// Etapas detalhadas no breakdown até a 1ª entrega. "Outras etapas" é um bucket
// catch-all (URGÊNCIAS, Captação, Atrasos, etc.) para que a soma do breakdown
// FECHE exatamente com o tempo total exibido — nada é descartado.
export var ETAPAS_PRE_ENTREGA = ['Planejamento', 'A fazer 👇', 'Em andamento 💪', 'Alterações ✏️', 'Revisão Interna 🔎', 'Outras etapas'];
// Níveis de esforço esperados no custom field "Nível de Esforço".
export var NIVEIS_ESFORCO = ['BAIXO', 'MÉDIO', 'ALTO', 'MUITO ALTO'];
// Data de início do indicador: só entram cards CRIADOS a partir daqui (abertos E
// arquivados). Antes 30/06/2026; recuada para 04/05/2026 para considerar cards mais
// antigos. Também limita o fetch de arquivados (não puxa histórico anterior a esta data).
export var PRIMEIRA_ENTREGA_EPOCH = new Date('2026-05-04T00:00:00');

export var DEFAULT_SLA = {};
var slaDefaults = [2, 5, 1, 3, 5, 2, 2, 2, 3, 2, 999];
FLOW_LISTS.forEach(function(n, i) { DEFAULT_SLA[n] = slaDefaults[i]; });

export var DEFAULTS = {
  // meta_leadtime      = meta de AGING (dias úteis na etapa atual) — KPI antigo, mantido
  // meta_leadtime_real = meta de LEAD TIME real (atravessamento do fluxo até concluir) — KPI novo
  meta_prazo: 20, meta_rework: 120, meta_leadtime: 7, meta_leadtime_real: 15, meta_through: 12, meta_conformidade: 85,
  // peso3 = aging (era 20, dividido com o novo lead time real para não duplicar impacto)
  // peso6 = lead time real (novo)
  peso1: 30, peso2: 20, peso3: 10, peso4: 10, peso5: 20, peso6: 10,
  sla: DEFAULT_SLA
};

// Cor por nivel de esforco (compartilhada entre dashboard, paineis e MS Project).
export var COR_NIVEL = { 'BAIXO': '#2E9E5B', 'MÉDIO': '#F2B705', 'ALTO': '#E5484D', 'MUITO ALTO': '#B91C3C' };
