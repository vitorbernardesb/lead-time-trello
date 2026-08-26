// ==========================================================================
//  Credenciais e endpoint da API do Trello.
//  
//  ATENCAO: TRELLO_TOKEN e um token de usuario com escopo read,write.
//  Este repositorio e publico (GitHub Pages) — o token e legivel por qualquer
//  pessoa. Trocar por fluxo de autorizacao por usuario (t.getRestApi) e a
//  correcao definitiva; centralizar aqui e apenas o primeiro passo.
//  
//  Compartilhado por dashboard.html e index.html.
// ==========================================================================

export var APP_KEY = '35b840777660fac1ae7823df3d2398f6';
export var TRELLO_TOKEN = 'ATTAa452bde3af25da62c9bf3061e522b13a132b95f557ff528b4b3a5aaa8aac01165F42B089';
export var APP_NAME = 'Lead Time Midiática';

export function apiUrl(path, token) {
  return 'https://api.trello.com/1'+path+(path.indexOf('?')>=0?'&':'?')+'key='+APP_KEY+'&token='+token;
}
