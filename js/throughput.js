// Fonte única da vazão: um card só conta quando continua em Concluído e usa
// exclusivamente sua última entrada nessa lista como data oficial de conclusão.
export const CONCLUDED_LIST = 'Concluído 🏆';
export const APP_TIME_ZONE = 'America/Sao_Paulo';

const dateParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
});

function pad2(value) { return String(value).padStart(2, '0'); }
function partsKey(year, month, day) { return year + '-' + pad2(month) + '-' + pad2(day); }

// Datas do Trello são instantes UTC. A conversão para dia civil acontece uma única
// vez, de forma explícita, no timezone operacional do dashboard.
export function conclusionDayKey(value) {
  var date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  var parts = {};
  dateParts.formatToParts(date).forEach(function(part) {
    if (part.type !== 'literal') parts[part.type] = parseInt(part.value, 10);
  });
  return partsKey(parts.year, parts.month, parts.day);
}

// Meta acumulada até o dia atual (inclusive), no mesmo fuso da vazão.
// Seg–sex, sem feriados, como o calendário útil da aplicação. Não arredondar
// a meta antes do score: o arredondamento é apenas de apresentação.
export function monthlyThroughputTarget(monthlyTarget, now = new Date()) {
  const key = conclusionDayKey(now);
  if (!key) throw new Error('Data inválida para a meta de vazão');
  const [year, month, today] = key.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let elapsedBusinessDays = 0, totalBusinessDays = 0;
  for (let day = 1; day <= daysInMonth; day++) {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    totalBusinessDays++;
    if (day <= today) elapsedBusinessDays++;
  }
  return {
    expected: Number(monthlyTarget) * elapsedBusinessDays / totalBusinessDays,
    elapsedBusinessDays, totalBusinessDays
  };
}

// Datas escolhidas na UI já são dias civis; não devem sofrer outra conversão de fuso.
export function selectedDayKey(date) {
  return partsKey(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function mondayKey(dayKey) {
  var p = dayKey.split('-').map(Number);
  var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  var offset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offset);
  return partsKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function periodKey(dayKey, grouping) {
  if (grouping === 'day') return dayKey;
  if (grouping === 'week') return mondayKey(dayKey);
  if (grouping === 'month') return dayKey.slice(0, 7);
  throw new Error('Agrupamento de vazão inválido: ' + grouping);
}

export function latestConclusionFromActions(actions) {
  var latest = null;
  (actions || []).forEach(function(action) {
    var listAfter = action && action.data && action.data.listAfter;
    if (action.type !== 'updateCard' || !listAfter || String(listAfter.name || '').trim() !== CONCLUDED_LIST) return;
    var date = new Date(action.date);
    if (!Number.isFinite(date.getTime())) return;
    if (!latest || date > latest) latest = date;
  });
  return latest ? latest.toISOString() : null;
}

export function selectCompletedCards(cards, ignoredIds) {
  var ignored = ignoredIds || new Set();
  var unique = new Map();
  (cards || []).forEach(function(card) {
    if (!card || !card.id || card.isArchived || card.closed || card.isIgnored || ignored.has(card.id)) return;
    if (String(card.currentListName || '').trim() !== CONCLUDED_LIST) return;
    var official = card.concludedAt || card.officialConclusionAt;
    var dayKey = conclusionDayKey(official);
    if (!dayKey) return;
    unique.set(card.id, {
      ...card,
      officialConclusionAt: new Date(official).toISOString(),
      conclusionDay: dayKey,
      isArchived: false,
      isIgnored: false
    });
  });
  return Array.from(unique.values());
}

export function groupCompletedCards(completedCards, start, end, grouping) {
  var startKey = selectedDayKey(start), endKey = selectedDayKey(end);
  var groups = new Map();
  (completedCards || []).forEach(function(card) {
    if (card.conclusionDay < startKey || card.conclusionDay > endKey) return;
    var key = periodKey(card.conclusionDay, grouping);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(card);
  });
  return Array.from(groups.entries()).sort(function(a, b) { return a[0].localeCompare(b[0]); })
    .map(function(entry) { return { key: entry[0], value: entry[1].length, cards: entry[1] }; });
}

export function throughputForPeriod(completedCards, start, end) {
  return groupCompletedCards(completedCards, start, end, 'day')
    .reduce(function(total, point) { return total + point.value; }, 0);
}
