'use strict';

// Fondamenta dell'app Film: servizi Luna, comandi da root, toast, menu di scelta, navigazione col telecomando.
// (Versione ridotta di quella della dashboard: le due app restano indipendenti.)

const APP_ID = 'it.casa.dashboard.film';
const DASHBOARD_ID = 'it.casa.dashboard';
const IS_WEBOS = typeof window.PalmServiceBridge === 'function';
const KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, ESC: 27, BACK: 461 };

const $ = (sel) => document.querySelector(sel);
const pad = (n) => String(n).padStart(2, '0');

function jsonSicuro(testo) {
  try { return JSON.parse(testo); } catch (e) { return null; }
}

function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// ---------- Servizi Luna ----------

const bridgeAttivi = new Set();

function luna(uri, params) {
  return new Promise((resolve, reject) => {
    if (!IS_WEBOS) { reject(new Error('Non in esecuzione su webOS')); return; }
    const bridge = new PalmServiceBridge();
    bridgeAttivi.add(bridge);
    const timer = setTimeout(() => {
      bridgeAttivi.delete(bridge);
      reject(new Error('Timeout: ' + uri));
    }, 10000);
    bridge.onservicecallback = (msg) => {
      clearTimeout(timer);
      bridgeAttivi.delete(bridge);
      const res = jsonSicuro(msg);
      if (!res) reject(new Error('Risposta non valida da ' + uri));
      else if (res.returnValue === false) reject(new Error(res.errorText || ('Errore ' + uri)));
      else resolve(res);
    };
    bridge.call(uri, JSON.stringify(params || {}));
  });
}

// Comando come root tramite Homebrew Channel; stdin da /dev/null (luna-send esce subito se è chiuso)
function sh(command) {
  return luna('luna://org.webosbrew.hbchannel.service/exec', { command: `{ ${command}\n} </dev/null` }).then((r) => r.stdoutString || '');
}

function lunaRoot(uri, params) {
  return sh(`luna-send -n 1 ${uri} ${shQuote(JSON.stringify(params || {}))}`).then((out) => {
    const res = jsonSicuro(out);
    if (!res) throw new Error('Risposta non valida da ' + uri);
    if (res.returnValue === false) throw new Error(res.errorText || ('Errore ' + uri));
    return res;
  });
}

function lunaConFallback(uri, params) {
  return luna(uri, params).catch(() => lunaRoot(uri, params));
}

function cartellaApp() {
  return decodeURIComponent(location.pathname).replace(/\/[^/]*$/, '');
}

// La dashboard è installata accanto: da lì si leggono config.json (chiave TMDB) e lo stato condiviso
function cartellaDashboard() {
  return cartellaApp().replace(/[^/]+$/, DASHBOARD_ID);
}

// Testo da un URL; senza CORS lo scarica la TV con curl
async function fetchTesto(url, intestazioni = {}) {
  try {
    const r = await fetch(url, { headers: intestazioni });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } catch (e) {
    if (!IS_WEBOS) throw e;
    const h = Object.keys(intestazioni).map((k) => '-H ' + shQuote(`${k}: ${intestazioni[k]}`)).join(' ');
    const out = await sh(`curl -sSfL --max-time 15 ${h} ${shQuote(url)}`);
    if (!out) throw e;
    return out;
  }
}

// ---------- Toast ----------

let timerToast;
function toast(testo) {
  const el = $('#toast');
  el.textContent = testo;
  el.classList.add('visibile');
  clearTimeout(timerToast);
  timerToast = setTimeout(() => el.classList.remove('visibile'), 3500);
}

// ---------- Menu di scelta ----------

let sceltaRisolvi = null;
let focusPrimaScelta = null;

function scegli(titolo, opzioni) {
  chiudiScelta(null);
  focusPrimaScelta = document.activeElement;
  $('#scelta-titolo').textContent = titolo;
  const box = $('#scelta-opzioni');
  box.innerHTML = '';
  opzioni.forEach((o) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'focusable btn';
    b.textContent = o.etichetta;
    b.addEventListener('click', () => chiudiScelta(o.valore));
    box.appendChild(b);
  });
  $('#scelta').hidden = false;
  const primo = box.querySelector('.btn');
  if (primo) primo.focus({ preventScroll: true });
  return new Promise((resolve) => { sceltaRisolvi = resolve; });
}

function chiudiScelta(valore) {
  if (!sceltaRisolvi) return;
  const risolvi = sceltaRisolvi;
  sceltaRisolvi = null;
  $('#scelta').hidden = true;
  if (focusPrimaScelta && document.contains(focusPrimaScelta)) focusPrimaScelta.focus({ preventScroll: true });
  risolvi(valore);
}

// ---------- Navigazione col telecomando ----------

function elementiNavigabili() {
  const ambito = !$('#scelta').hidden ? $('#scelta') : $('#schermo');
  return Array.from(ambito.querySelectorAll('.focusable'))
    .filter((el) => el.offsetParent !== null && !el.disabled);
}

// Porta in vista l'elemento: righe orizzontali e area verticale scorrono senza spostare la pagina
function rendiVisibile(el) {
  const riga = el.closest('.riga-locandine');
  if (riga) {
    const sinistra = el.offsetLeft - 24;
    if (sinistra < riga.scrollLeft) riga.scrollLeft = sinistra;
    else if (el.offsetLeft + el.offsetWidth + 24 > riga.scrollLeft + riga.clientWidth) {
      riga.scrollLeft = el.offsetLeft + el.offsetWidth + 24 - riga.clientWidth;
    }
  }
  const area = el.closest('.contenuto');
  if (area) {
    const sezione = el.closest('.sezione');
    const r = el.getBoundingClientRect();
    const a = area.getBoundingClientRect();
    const s = sezione && sezione.getBoundingClientRect();
    if (s && r.top - s.top < 160) {
      // Prima riga di una sezione: la sezione parte dall'alto, titolo compreso
      area.scrollTop += s.top - a.top - 4;
    } else if (r.top - 24 < a.top) {
      area.scrollTop += r.top - 24 - a.top;
    } else if (r.bottom + 24 > a.bottom) {
      area.scrollTop += r.bottom + 24 - a.bottom;
    }
  }
  if (el.closest('.overlay')) el.scrollIntoView({ block: 'nearest' });
}

function focalizza(el) {
  if (!el) return;
  el.focus({ preventScroll: true });
  rendiVisibile(el);
  // L'evento focus non arriva se la finestra non ha il focus (anteprima): l'app viene avvisata anche così
  if (typeof alFocus === 'function') alFocus(el);
}

function centro(r) {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function muovi(direzione) {
  const elementi = elementiNavigabili();
  const corrente = document.activeElement;
  if (!elementi.includes(corrente)) {
    if (elementi[0]) focalizza(elementi[0]);
    return;
  }
  const rc = corrente.getBoundingClientRect();
  const a = centro(rc);
  const orizzontale = direzione === 'sinistra' || direzione === 'destra';
  const stessaRiga = (el) => {
    const r = el.getBoundingClientRect();
    return r.top < rc.bottom && r.bottom > rc.top;
  };
  let migliore = null;
  let punteggioMigliore = Infinity;
  elementi.forEach((el) => {
    if (el === corrente) return;
    // ◀ ▶ non cambiano riga: in fondo a una riga ci si ferma
    if (orizzontale && !stessaRiga(el)) return;
    const b = centro(el.getBoundingClientRect());
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let primario;
    let secondario;
    if (direzione === 'sinistra') { if (dx > -1) return; primario = -dx; secondario = Math.abs(dy); }
    if (direzione === 'destra') { if (dx < 1) return; primario = dx; secondario = Math.abs(dy); }
    if (direzione === 'su') { if (dy > -1) return; primario = -dy; secondario = Math.abs(dx); }
    if (direzione === 'giu') { if (dy < 1) return; primario = dy; secondario = Math.abs(dx); }
    const punteggio = primario + secondario * (orizzontale ? 2.5 : 1.2);
    if (punteggio < punteggioMigliore) { punteggioMigliore = punteggio; migliore = el; }
  });
  if (migliore) focalizza(migliore);
}

// ---------- Scala per l'anteprima fuori dalla TV ----------

function adattaScala() {
  const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  $('#schermo').style.transform = s === 1 ? '' : `scale(${s})`;
}
window.addEventListener('resize', adattaScala);
