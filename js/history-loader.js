// Cache de histórico fora do limite pequeno e síncrono de localStorage.
const memory = new Map();
let database;
function openDatabase() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('midiatica-history', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('cache');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Armazenamento bloqueado'));
  });
  return database;
}
export async function readHistoryCache(key) {
  if (memory.has(key)) return memory.get(key);
  try {
    const db = await openDatabase();
    const value = await new Promise((resolve, reject) => {
      const request = db.transaction('cache').objectStore('cache').get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (value) memory.set(key, value);
    return value;
  } catch (error) {
    console.warn('[CACHE] Leitura indisponível; usando memória:', error.message);
    return memory.get(key);
  }
}
export async function writeHistoryCache(key, value) {
  memory.set(key, value);
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('cache', 'readwrite');
      tx.objectStore('cache').put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Gravação cancelada'));
    });
  } catch (error) {
    console.warn('[CACHE] Persistência indisponível; cache mantido em memória:', error.message);
  }
}

const actionQuery = 'filter=updateCard:idList,createCard,copyCard&limit=1000&fields=id,type,date,data&memberCreator=false&member=false';
// Só uma paginação COMPLETA pode alimentar o cache. Falhas não viram arrays vazios.
export async function fetchActionPages(request, path, progress = () => {}) {
  let cursor;
  const seen = new Set(), unique = new Map();
  for (let pageNumber = 1; ; pageNumber++) {
    const page = await request(path + (cursor ? '&before=' + encodeURIComponent(cursor) : ''));
    if (!Array.isArray(page)) throw new Error('Histórico retornado em formato inválido');
    for (const action of page) unique.set(action.id || JSON.stringify(action), action);
    progress(pageNumber);
    if (page.length < 1000) return [...unique.values()];
    cursor = page.at(-1)?.id || page.at(-1)?.date;
    if (!cursor || seen.has(cursor)) throw new Error('Paginação do histórico não avançou');
    seen.add(cursor);
  }
}

function hasCreation(actions) {
  return actions.some(a => (a.type === 'createCard' || a.type === 'copyCard') && a.data?.list);
}

export async function loadCardHistories({ cards, boardId, request, cache = {}, since, progress = () => {} }) {
  const result = new Map();
  const missing = cards.filter(card => {
    const hit = cache[card.id];
    if (hit?.complete && hit.la === card.dateLastActivity && Array.isArray(hit.a)) {
      result.set(card.id, hit.a);
      return false;
    }
    return true;
  });
  let completed = result.size;
  progress(completed, cards.length);
  // Poucas mudanças: reaproveitar todos os demais cards e consultar só os alterados.
  // Carga fria: histórico do board em poucas páginas, com fallback para cards cuja
  // criação é anterior à janela ou aconteceu em outro board.
  let grouped = new Map();
  if (missing.length > 12) {
    const wanted = new Set(missing.map(c => c.id));
    const actions = await fetchActionPages(request, '/boards/' + boardId + '/actions?' + actionQuery +
      '&since=' + encodeURIComponent(since), page => progress(completed, cards.length, page));
    for (const action of actions) {
      const id = action.data?.card?.id;
      if (!wanted.has(id)) continue;
      if (!grouped.has(id)) grouped.set(id, []);
      grouped.get(id).push(action);
    }
  }
  await Promise.all(missing.map(async card => {
    let actions = grouped.get(card.id);
    // Nunca assumir que a janela do board cobre todo o passado de um card.
    if (!actions || !hasCreation(actions)) {
      actions = await fetchActionPages(request, '/cards/' + card.id + '/actions?' + actionQuery);
    }
    result.set(card.id, actions);
    cache[card.id] = { la: card.dateLastActivity, a: actions, complete: true };
    progress(++completed, cards.length);
  }));
  return { actions: cards.map(card => result.get(card.id)), cache };
}
