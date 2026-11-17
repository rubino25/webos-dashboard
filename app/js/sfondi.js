'use strict';

// Sfondi della dashboard e del salvaschermo: Bing (foto del giorno), NASA (Image of the Day), foto del NAS (DLNA).
// L'elenco si rilegge ogni 6 ore e resta in memoria locale, così all'avvio lo sfondo c'è subito.
// Sulla dashboard l'immagine è scurita (i testi devono leggersi) e cambia ogni sfondoMin minuti;
// nel salvaschermo è più luminosa, si muove piano e cambia ogni 90 secondi (niente immagini fisse sull'OLED).

const FONTI_SFONDO = {
  bing: 'Bing',
  nasa: 'NASA',
  dlna: 'foto del NAS',
};
const CHIAVE_SFONDI = 'dashboard.sfondi';
const VALIDITA_SFONDI = 6 * 3600 * 1000;
const CAMBIO_SALVASCHERMO = 90 * 1000;

let sfondi = [];         // [{ url, titolo, fonte }]
let ordineSfondi = [];   // posizioni mescolate
let posSfondo = -1;
let timerSfondo = null;
let sfondoNelSalvaschermo = false;
let caricamentoSfondo = 0;

const fontiSfondo = () => (Array.isArray(impostazioni.sfondi) ? impostazioni.sfondi : []).filter((f) => FONTI_SFONDO[f]);

// ---------- Fonti ----------

async function sfondiBing() {
  // Bing non permette CORS: fetchTesto ripiega su curl dalla TV
  const d = JSON.parse(await fetchTesto('https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=8&mkt=it-IT'));
  return (d.images || []).map((i) => ({ url: 'https://www.bing.com' + i.url, titolo: i.copyright || i.title || '', fonte: 'bing' }));
}

async function sfondiNasa() {
  // L'API "APOD" della NASA oggi restituisce solo il logo: si usa il feed "Image of the Day".
  // Le foto originali pesano anche 8 MB: ?w=1920 le fa ridurre dal sito (~0,5 MB)
  const xml = new DOMParser().parseFromString(await fetchTesto('https://www.nasa.gov/feeds/iotd-feed/'), 'text/xml');
  return Array.from(xml.querySelectorAll('item')).slice(0, 30).map((it) => {
    const allegato = it.querySelector('enclosure');
    const url = allegato && allegato.getAttribute('url');
    if (!url || !/\.(jpe?g|png|webp)$/i.test(url.split('?')[0])) return null;
    const titolo = it.querySelector('title');
    return { url: url.split('?')[0] + '?w=1920', titolo: titolo ? titolo.textContent.trim() : '', fonte: 'nasa' };
  }).filter(Boolean);
}

async function sfondiDlna() {
  if (!IS_WEBOS) return [];
  const server = (config.dlna && config.dlna.url) || '';
  const out = await sh(`cd ${shQuote(cartellaApp())} && python3 dlna.py immagini ${server ? shQuote(server) : ''}`);
  const d = jsonSicuro(out.trim());
  if (!d || d.errore) throw new Error(d ? d.errore : 'risposta non valida');
  return (d.foto || [])
    .filter((f) => !f.larghezza || !f.altezza || f.larghezza >= f.altezza * 1.2)
    .map((f) => ({ url: f.url, titolo: f.titolo || '', fonte: 'dlna' }));
}

const LETTORI_SFONDO = { bing: sfondiBing, nasa: sfondiNasa, dlna: sfondiDlna };

function leggiCacheSfondi() {
  try { return JSON.parse(localStorage.getItem(CHIAVE_SFONDI) || 'null'); } catch (e) { return null; }
}

// forza: rilegge le fonti anche se l'elenco salvato è recente
async function caricaSfondi(forza) {
  const fonti = fontiSfondo();
  const cache = leggiCacheSfondi();
  const valide = cache && Array.isArray(cache.voci) ? cache.voci.filter((v) => fonti.includes(v.fonte)) : [];
  if (!forza && cache && cache.fonti === fonti.join(',') && Date.now() - cache.quando < VALIDITA_SFONDI && valide.length) {
    impostaElencoSfondi(valide);
    return;
  }
  const risultati = await Promise.all(fonti.map((f) => LETTORI_SFONDO[f]().catch(() => null)));
  // Una fonte che non risponde (rete giù, NAS spento) tiene le immagini di prima
  const voci = [];
  fonti.forEach((f, i) => voci.push(...(risultati[i] || valide.filter((v) => v.fonte === f))));
  try { localStorage.setItem(CHIAVE_SFONDI, JSON.stringify({ quando: Date.now(), fonti: fonti.join(','), voci })); } catch (e) { /* storage pieno */ }
  impostaElencoSfondi(voci);
}

// ---------- Visualizzazione ----------

function mescola(n) {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function impostaElencoSfondi(voci) {
  const prima = sfondi.map((v) => v.url).join('|');
  sfondi = voci;
  if (voci.map((v) => v.url).join('|') !== prima) {
    ordineSfondi = mescola(voci.length);
    posSfondo = -1;
  }
  document.body.classList.toggle('con-sfondo', sfondi.length > 0);
  if (sfondi.length && !document.querySelector('.sfondo-img.visibile')) prossimoSfondo();
  // Aperta direttamente come salvaschermo: l'elenco arriva dopo l'attivazione
  if (salvaschermoAttivo && !sfondoNelSalvaschermo && sfondi.length) sfondoSalvaschermo(true);
}

// Carica la prossima immagine e la mostra con una dissolvenza; salta quelle verticali, piccole o rotte
function prossimoSfondo(tentativi = 0) {
  if (!sfondi.length || tentativi >= Math.min(sfondi.length, 8)) return;
  posSfondo = (posSfondo + 1) % sfondi.length;
  if (posSfondo === 0 && tentativi === 0 && sfondi.length > 2) ordineSfondi = mescola(sfondi.length);
  const voce = sfondi[ordineSfondi[posSfondo]];
  if (!voce) return;
  const turno = ++caricamentoSfondo;
  const img = new Image();
  img.onload = () => {
    if (turno !== caricamentoSfondo) return;
    if (img.naturalWidth < 1000 || img.naturalWidth < img.naturalHeight * 1.2) { prossimoSfondo(tentativi + 1); return; }
    const livelli = document.querySelectorAll('.sfondo-img');
    const visibile = document.querySelector('.sfondo-img.visibile');
    const nuovo = visibile === livelli[0] ? livelli[1] : livelli[0];
    nuovo.src = img.src;
    nuovo.classList.add('visibile');
    if (visibile) visibile.classList.remove('visibile');
    $('#ss-didascalia').textContent = voce.titolo ? `${voce.titolo} · ${FONTI_SFONDO[voce.fonte] || ''}` : '';
  };
  img.onerror = () => { if (turno === caricamentoSfondo) prossimoSfondo(tentativi + 1); };
  img.src = voce.url;
}

function programmaSfondo() {
  clearInterval(timerSfondo);
  timerSfondo = null;
  if (!fontiSfondo().length) return;
  const ogni = sfondoNelSalvaschermo ? CAMBIO_SALVASCHERMO : Math.max(5, impostazioni.sfondoMin || 30) * 60000;
  timerSfondo = setInterval(() => {
    if (document.hidden) return;
    // L'elenco scaduto si rilegge (Bing e NASA cambiano ogni giorno)
    const cache = leggiCacheSfondi();
    if (!cache || Date.now() - cache.quando > VALIDITA_SFONDI) caricaSfondi(true);
    prossimoSfondo();
  }, ogni);
}

// All'avvio e quando cambiano le impostazioni degli sfondi
async function applicaSfondi(forza) {
  const fonti = fontiSfondo();
  if (!fonti.length) {
    sfondi = [];
    document.body.classList.remove('con-sfondo', 'ss-con-sfondo');
    document.querySelectorAll('.sfondo-img').forEach((i) => { i.classList.remove('visibile'); i.removeAttribute('src'); });
    $('#ss-didascalia').textContent = '';
    programmaSfondo();
    return;
  }
  programmaSfondo();
  await caricaSfondi(forza);
}

// Chiamata da attivaSalvaschermo / disattivaSalvaschermo
function sfondoSalvaschermo(attivo) {
  sfondoNelSalvaschermo = attivo && impostazioni.sfondoSalvaschermo !== false && sfondi.length > 0;
  document.body.classList.toggle('ss-con-sfondo', sfondoNelSalvaschermo);
  programmaSfondo();
  if (sfondoNelSalvaschermo) prossimoSfondo();
}

// ---------- Impostazioni (pannello sulla TV) ----------

function descriviSfondi() {
  const fonti = fontiSfondo();
  if (!fonti.length) return 'Sfondi: nessuno';
  return `Sfondi: ${fonti.map((f) => FONTI_SFONDO[f]).join(', ')} · ogni ${impostazioni.sfondoMin || 30} min`;
}

async function scegliSfondi() {
  const MINUTI = [15, 30, 60, 120];
  for (;;) {
    const fonti = fontiSfondo();
    const v = await scegli('Sfondi', [
      { etichetta: 'Bing, foto del giorno: ' + siNo(fonti.includes('bing')), valore: 'bing' },
      { etichetta: 'NASA, immagine del giorno: ' + siNo(fonti.includes('nasa')), valore: 'nasa' },
      { etichetta: 'Foto del NAS (cartella Foto del DLNA): ' + siNo(fonti.includes('dlna')), valore: 'dlna' },
      { etichetta: `Cambia ogni ${impostazioni.sfondoMin || 30} minuti`, valore: 'minuti' },
      { etichetta: 'Anche nel salvaschermo: ' + siNo(impostazioni.sfondoSalvaschermo !== false), valore: 'salvaschermo' },
      { etichetta: 'Fatto', valore: 'fatto' },
    ]);
    if (!v || v === 'fatto') break;
    if (FONTI_SFONDO[v]) {
      impostazioni.sfondi = fonti.includes(v) ? fonti.filter((f) => f !== v) : fonti.concat(v);
    } else if (v === 'minuti') {
      impostazioni.sfondoMin = MINUTI[(MINUTI.indexOf(impostazioni.sfondoMin || 30) + 1) % MINUTI.length];
    } else if (v === 'salvaschermo') {
      impostazioni.sfondoSalvaschermo = impostazioni.sfondoSalvaschermo === false;
    }
    salvaImpostazioni();
    aggiornaPannello();
    if (FONTI_SFONDO[v] || v === 'minuti') applicaSfondi(FONTI_SFONDO[v] && impostazioni.sfondi.includes(v));
  }
  const fonti = fontiSfondo();
  if (fonti.includes('dlna') && sfondi.length && !sfondi.some((s) => s.fonte === 'dlna')) {
    toast('Nessuna foto nella cartella Foto del NAS: aggiungi una cartella di foto alla libreria multimediale del NAS');
  }
}
