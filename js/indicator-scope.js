// Independent board keys avoid overwriting another user's decisions on other cards.
export const EXCLUSION_PREFIX = 'indicatorExcluded_';
export function exclusionIds(boardData) {
  return new Set(Object.keys(boardData || {}).filter(key =>
    key.startsWith(EXCLUSION_PREFIX) && boardData[key] === true
  ).map(key => key.slice(EXCLUSION_PREFIX.length)));
}

// Keep the complete source alongside the scoped view so exclusion is reversible.
export function scopeIndicatorData(data, excluded) {
  const allCards = data.allCards || data.cards || [];
  const allArchived = data.allArchived || data.archived || [];
  const allThroughput = data.allThroughput || data.throughput || {};
  const throughput = { ...allThroughput };
  for (const card of allCards) {
    if (!excluded.has(card.id)) continue;
    const contribution = (data.throughputByCard || {})[card.id] || {};
    for (const [stage, count] of Object.entries(contribution)) {
      throughput[stage] = Math.max(0, (throughput[stage] || 0) - count);
    }
  }
  return {
    ...data, allCards, allArchived, allThroughput, throughput,
    cards: allCards.filter(card => !excluded.has(card.id)),
    archived: allArchived.filter(card => !excluded.has(card.id))
  };
}
