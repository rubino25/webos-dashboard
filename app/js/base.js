'use strict';

// Fondamenta condivise: impostazioni, servizi Luna, toast, finestre di scelta, navigazione col telecomando

const APP_ID = 'it.casa.dashboard';
const IS_WEBOS = typeof window.PalmServiceBridge === 'function';
const STORAGE_KEY = 'dashboard.impostazioni';
const DEFAULTS = {
  citta: 'Roma', lat: 41.8919, lon: 12.5113, secondi: false,
  ordine: [], nascoste: [], preferite: null,
  home: false, accensione: false, salvaschermoLg: false, salvaschermoMin: 10, web: true,
  // Wake-on-LAN: dispositivo da accendere, ingresso che lo accende da solo ('' = nessuno), pulsante tra i comandi
  wolNome: '', wolMac: '', wolIngresso: '', wolIngressoNome: '', wolPulsante: true,
};

const KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, ESC: 27, BACK: 461 };

const $ = (sel) => document.querySelector(sel);
const pad = (n) => String(n).padStart(2, '0');
const maiuscola = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const oraMinuti = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function jsonSicuro(testo) {
  try { return JSON.parse(testo); } catch (e) { return null; }
}

// ---------- Impostazioni ----------
// Stanno in un file sulla TV, condiviso con la pagina web di configurazione (configura.py).
// Il localStorage ne tiene una copia per partire subito, prima che il file sia letto.

const FILE_IMPOSTAZIONI = '/var/lib/webosbrew/dashboard/impostazioni.json';
const PORTA_CONFIGURA = 8095;

function caricaImpostazioni() {
  try {
    return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}

let timerScritturaImpostazioni = null;

function salvaImpostazioni() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(impostazioni)); } catch (e) { /* storage non disponibile */ }
  if (!IS_WEBOS) return;
  // Più modifiche di fila (es. preferite) diventano una sola scrittura
  clearTimeout(timerScritturaImpostazioni);
  timerScritturaImpostazioni = setTimeout(scriviFileImpostazioni, 400);
}

function scriviFileImpostazioni() {
  timerScritturaImpostazioni = null;
  const tmp = FILE_IMPOSTAZIONI + '.tmp';
  return sh(`mkdir -p ${shQuote(FILE_IMPOSTAZIONI.replace(/\/[^/]+$/, ''))} && printf '%s' ${shQuote(JSON.stringify(impostazioni))} > ${tmp} && mv ${tmp} ${FILE_IMPOSTAZIONI}`)
    .catch(() => { /* resta la copia locale */ });
}

// Legge il file sulla TV (modificato anche dalla pagina web); true se qualcosa è cambiato.
// Al primo avvio con questa versione il file non c'è: lo crea con le impostazioni attuali.
async function leggiFileImpostazioni() {
  if (!IS_WEBOS) return false;
  let testo;
  try {
    testo = (await sh(`cat ${FILE_IMPOSTAZIONI} 2>/dev/null`)).trim();
  } catch (e) {
    return false;
  }
  const dati = jsonSicuro(testo);
  if (!dati || typeof dati !== 'object') {
    if (!testo) scriviFileImpostazioni();
    return false;
  }
  if (timerScritturaImpostazioni) return false; // una modifica fatta qui deve ancora essere scritta: vince quella
  const prima = JSON.stringify(impostazioni);
  impostazioni = Object.assign({}, DEFAULTS, dati);
  if (JSON.stringify(impostazioni) === prima) return false;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(impostazioni)); } catch (e) { /* storage non disponibile */ }
  return true;
}

let impostazioni = caricaImpostazioni();

// config.json facoltativo, preparato sul PC e incluso nel pacchetto da build.py
let config = {};

function caricaConfig() {
  // XHR e non fetch: fetch non legge i file locali dell'app (file://)
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'config.json');
    xhr.onload = () => {
      const c = jsonSicuro(xhr.responseText);
      if (c && typeof c === 'object') config = c;
      resolve();
    };
    xhr.onerror = () => resolve();
    xhr.send();
  });
}

// ---------- Servizi Luna ----------

// I bridge vanno tenuti referenziati finché arriva la risposta, altrimenti il GC li raccoglie
const bridgeAttivi = new Set();

function luna(uri, params) {
  return new Promise((resolve, reject) => {
    if (!IS_WEBOS) { reject(new Error('Non in esecuzione su webOS')); return; }
    const bridge = new PalmServiceBridge();
    bridgeAttivi.add(bridge);
    const timer = setTimeout(() => {
      bridgeAttivi.delete(bridge);
      reject(new Error('Timeout: ' + uri));
    }, 8000);
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

function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Esegue un comando come root tramite il servizio di Homebrew Channel.
// Stdin da /dev/null: con uno stdin chiuso luna-send esce prima di ricevere la risposta.
function sh(command) {
  return luna('luna://org.webosbrew.hbchannel.service/exec', { command: `{ ${command}\n} </dev/null` }).then((r) => r.stdoutString || '');
}

// Chiamata Luna fatta da root con luna-send, per i metodi negati alle app normali
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

// Prova più servizi equivalenti (cambiano tra versioni di webOS) e ricorda quello che risponde
const endpointValidi = {};

async function lunaCandidati(nome, candidati, argomento) {
  const lista = endpointValidi[nome] ? [endpointValidi[nome]] : candidati;
  let ultimoErrore = null;
  for (const c of lista) {
    try {
      const r = await lunaConFallback(c.uri, c.params ? c.params(argomento) : (argomento || {}));
      endpointValidi[nome] = c;
      return r;
    } catch (e) {
      ultimoErrore = e;
    }
  }
  throw ultimoErrore || new Error('Nessun servizio disponibile');
}

// Cartella dell'app installata sulla TV (dove si trova servizio.sh)
function cartellaApp() {
  return decodeURIComponent(location.pathname).replace(/\/[^/]*$/, '');
}

function servizio(argomenti) {
  return sh(`sh ${shQuote(cartellaApp() + '/servizio.sh')} ${argomenti}`);
}

// Scarica un testo; se il sito non permette CORS lo scarica la TV come root con curl
async function fetchTesto(url, { metodo = 'GET', intestazioni = {}, corpo } = {}) {
  try {
    const r = await fetch(url, { method: metodo, headers: intestazioni, body: corpo });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } catch (e) {
    if (!IS_WEBOS) throw e;
    const h = Object.keys(intestazioni).map((k) => '-H ' + shQuote(`${k}: ${intestazioni[k]}`)).join(' ');
    const d = corpo !== undefined ? '-d ' + shQuote(corpo) : '';
    const out = await sh(`curl -sSfL --max-time 15 -X ${metodo} ${h} ${d} ${shQuote(url)}`);
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

// ---------- Finestra di scelta (menu, conferme, elenchi) ----------

let sceltaRisolvi = null;
let focusPrimaScelta = null;

// opzioni: [{ etichetta, valore, attiva }]; risolve con il valore scelto, o null con Indietro
function scegli(titolo, opzioni) {
  chiudiScelta(null);
  focusPrimaScelta = document.activeElement;
  $('#scelta-titolo').textContent = titolo;
  const box = $('#scelta-opzioni');
  box.innerHTML = '';
  let primo = null;
  opzioni.forEach((o) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'focusable btn' + (o.attiva ? ' attiva' : '');
    b.textContent = o.etichetta;
    b.addEventListener('click', () => chiudiScelta(o.valore));
    box.appendChild(b);
    if (!primo || (o.attiva && !primo.classList.contains('attiva'))) primo = b;
  });
  $('#scelta').hidden = false;
  if (primo) focalizza(primo);
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

function overlayAttivo() {
  if (!$('#scelta').hidden) return $('#scelta');
  if (!$('#scegli-preferite').hidden) return $('#scegli-preferite');
  if (!$('#impostazioni').hidden) return $('#impostazioni');
  return null;
}

// Fuori dalle liste che scorrono (Film) contano solo le voci visibili: quelle tagliate
// sotto la card non devono "rubare" il focus alla riga dei comandi o delle app
function visibileNellaLista(el) {
  const lista = el.closest('.lista-scorre');
  if (!lista) return true;
  const a = lista.getBoundingClientRect();
  const b = el.getBoundingClientRect();
  return b.bottom > a.top + 4 && b.top < a.bottom - 4;
}

function elementiNavigabili() {
  const ambito = overlayAttivo() || $('#schermo');
  return Array.from(ambito.querySelectorAll('.focusable'))
    .filter((el) => el.offsetParent !== null && !el.disabled && visibileNellaLista(el));
}

// Porta in vista l'elemento senza far scorrere la pagina (le pagine si spostano via transform)
function rendiVisibile(el) {
  const riga = el.closest('.scorrevole');
  const lista = el.closest('.lista-scorre');
  if (riga) {
    riga.scrollTo({ left: el.offsetLeft - (riga.clientWidth - el.offsetWidth) / 2, behavior: 'smooth' });
  } else if (lista) {
    // scrollTop diretto (l'animazione la fa scroll-behavior nel CSS): scrollTo smooth non si muove con overflow hidden
    const voce = el.closest('li') || el;
    if (voce.offsetTop < lista.scrollTop) lista.scrollTop = voce.previousElementSibling ? voce.offsetTop : 0;
    else if (voce.offsetTop + voce.offsetHeight > lista.scrollTop + lista.clientHeight) {
      lista.scrollTop = voce.nextElementSibling ? voce.offsetTop + voce.offsetHeight - lista.clientHeight : lista.scrollHeight;
    }
  } else if (el.closest('.overlay')) {
    el.scrollIntoView({ block: 'nearest' });
  }
}

function focalizza(el) {
  el.focus({ preventScroll: true });
  rendiVisibile(el);
}

function centro(r) {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// Su e giù dentro una lista che scorre: voce precedente o successiva, anche se ancora nascosta
function muoviInLista(corrente, direzione) {
  const lista = corrente.closest && corrente.closest('.lista-scorre');
  if (!lista || (direzione !== 'su' && direzione !== 'giu')) return false;
  const voci = Array.from(lista.querySelectorAll('.focusable'));
  const prossima = voci[voci.indexOf(corrente) + (direzione === 'su' ? -1 : 1)];
  // In fondo alla lista ▼ non esce verso i comandi: si esce con ◀ ▶ o ▲ dalla prima voce
  if (!prossima) return direzione === 'giu';
  focalizza(prossima);
  return true;
}

// Rotella del Magic Remote sulle liste che scorrono: una voce per scatto.
// Se il focus è nella lista lo sposta (come ▲ ▼), altrimenti scorre la lista sotto il puntatore.
let ultimaRotella = 0;
document.addEventListener('wheel', (e) => {
  const attivo = document.activeElement;
  const lista = (e.target.closest && e.target.closest('.lista-scorre')) || (attivo && attivo.closest && attivo.closest('.lista-scorre'));
  if (!lista || overlayAttivo() || !e.deltaY) return;
  e.preventDefault();
  const adesso = Date.now();
  if (adesso - ultimaRotella < 90) return;
  ultimaRotella = adesso;
  const direzione = e.deltaY > 0 ? 'giu' : 'su';
  if (lista.contains(attivo)) {
    muoviInLista(attivo, direzione);
  } else {
    const voce = lista.querySelector('li');
    lista.scrollTop += (direzione === 'giu' ? 1 : -1) * (voce ? voce.offsetHeight + 4 : 48);
  }
}, { passive: false });

function muovi(direzione) {
  const corrente = document.activeElement;
  if (muoviInLista(corrente, direzione)) return;
  const elementi = elementiNavigabili();
  if (!elementi.includes(corrente)) {
    if (elementi[0]) focalizza(elementi[0]);
    return;
  }
  const rc = corrente.getBoundingClientRect();
  const a = centro(rc);
  // Con ◀ ▶ si resta sulla stessa riga (es. Riavvia TV in fondo a destra); si cambia riga solo se lì non c'è nulla
  const stessaRiga = (el) => {
    const r = el.getBoundingClientRect();
    return r.top < rc.bottom && r.bottom > rc.top;
  };
  const orizzontale = direzione === 'sinistra' || direzione === 'destra';
  const versoGiusto = (el) => {
    const dx = centro(el.getBoundingClientRect()).x - a.x;
    return direzione === 'sinistra' ? dx <= -1 : dx >= 1;
  };
  const soloRiga = orizzontale && elementi.some((el) => el !== corrente && stessaRiga(el) && versoGiusto(el));
  let migliore = null;
  let punteggioMigliore = Infinity;
  elementi.forEach((el) => {
    if (el === corrente) return;
    if (soloRiga && !stessaRiga(el)) return;
    const b = centro(el.getBoundingClientRect());
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let primario;
    let secondario;
    if (direzione === 'sinistra') { if (dx > -1) return; primario = -dx; secondario = Math.abs(dy); }
    if (direzione === 'destra') { if (dx < 1) return; primario = dx; secondario = Math.abs(dy); }
    if (direzione === 'su') { if (dy > -1) return; primario = -dy; secondario = Math.abs(dx); }
    if (direzione === 'giu') { if (dy < 1) return; primario = dy; secondario = Math.abs(dx); }
    const punteggio = primario + secondario * 2.5;
    if (punteggio < punteggioMigliore) { punteggioMigliore = punteggio; migliore = el; }
  });
  if (migliore) focalizza(migliore);
}

// ---------- Pagine ----------

let paginaCorrente = 0;

function mostraPagina(n) {
  if (n === paginaCorrente) return;
  paginaCorrente = n;
  $('#pagine').style.transform = n ? `translateY(${-1080 * n}px)` : '';
}

document.addEventListener('focusin', (e) => {
  const pagina = e.target.closest && e.target.closest('.pagina');
  if (pagina) mostraPagina(Number(pagina.dataset.pagina));
});
