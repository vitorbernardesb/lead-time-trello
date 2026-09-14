// ==========================================================================
//  Estado compartilhado entre o script principal e os modulos de aba.
//  
//  `cachedData` e `renderedTabs` sao REATRIBUIDOS pelo loadRealtime. Modulos ES
//  expoem bindings vivos: quem importa `cachedData` sempre le o valor atual, mas
//  nao pode atribuir — por isso os setters abaixo.
// ==========================================================================

import { APP_KEY, APP_NAME } from './trello-api.js';
import { scopeIndicatorData } from './indicator-scope.js';

export const t = TrelloPowerUp.iframe({ appKey: APP_KEY, appName: APP_NAME });

export let cachedData = null;
export let ignoredIndicatorIds = new Set();
export function setIgnoredIndicatorIds(ids) { ignoredIndicatorIds = new Set(ids); }
export function setCachedData(v) { cachedData = v ? scopeIndicatorData(v, ignoredIndicatorIds) : null; }

export let renderedTabs = {};
export function resetRenderedTabs() { renderedTabs = {}; }
