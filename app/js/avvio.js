'use strict';

// Orologio, impostazioni, Home/salvaschermo sostitutivi, protezione OLED, tasti del telecomando e avvio

// ---------- Orologio ----------

function saluto(ora) {
  if (ora >= 5 && ora < 13) return 'Buongiorno';
  if (ora >= 13 && ora < 18) return 'Buon pomeriggio';
  if (ora >= 18 && ora < 23) return 'Buonasera';
  return 'Buonanotte';
}

function aggiornaOrologio() {
  const ora = new Date();
  $('#ora').innerHTML = `${pad(ora.getHours())}<span class="sep">:</span>${pad(ora.getMinutes())}` +
    (impostazioni.secondi ? `<span class="sec">${pad(ora.getSeconds())}</span>` : '');
  $('#ora-2').textContent = oraMinuti(ora);
  const data = maiuscola(ora.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
  $('#data').textContent = data;
  $('#saluto').textContent = saluto(ora.getHours());
  if (salvaschermoAttivo) {
    $('#ss-ora').textContent = oraMinuti(ora);
    $('#ss-data').textContent = data;
  }
  if (ora.getSeconds() === 0) aggiornaTimerUI();
}

// ---------- Opzioni condivise con servizio.sh (Home, accensione, salvaschermo LG) ----------

async function leggiOpzioniTv() {
  if (!IS_WEBOS) return;
  try {
    const v = {};
    (await servizio('opzioni')).split('\n').forEach((riga) => {
      const m = riga.match(/^(\w+)=(.*)$/);
      if (m) v[m[1]] = m[2];
    });
    // La TV è la fonte di verità: un "ripristina" fatto da SSH si vede anche qui
    impostazioni.home = v.HOME_DASHBOARD === '1';
    impostazioni.accensione = v.ACCENSIONE === '1';
    impostazioni.salvaschermoLg = v.SALVASCHERMO_LG === '1';
    impostazioni.web = v.PAGINA_WEB !== '0';
    impostazioni.homeRimossa = v.HOME_LG_RIMOSSA === '1';
    impostazioni.aggiornamentiBloccati = v.AGGIORNAMENTI_BLOCCATI === '1';
    impostazioni.alleggerisci = v.ALLEGGERISCI === '1';
    salvaImpostazioni();
    aggiornaPannello();
  } catch (e) { /* servizio non raggiungibile: restano le impostazioni locali */ }
}

async function scriviOpzioniTv() {
  if (!IS_WEBOS) return true;
  const ids = (lista, predefiniti) => (Array.isArray(lista) && lista.length ? lista : predefiniti)
    .filter((id) => /^[\w.-]+$/.test(id)).join(' ');
  const argomenti = [
    'imposta',
    impostazioni.home ? 1 : 0,
    impostazioni.accensione ? 1 : 0,
    impostazioni.salvaschermoLg ? 1 : 0,
    shQuote(ids(config.homeIds, ['com.webos.app.home'])),
    shQuote(ids(config.salvaschermoIds, ['com.webos.app.screensaver'])),
  ].join(' ');
  try {
    await servizio(argomenti);
    return true;
  } catch (e) {
    toast('Impossibile salvare sulla TV: ' + e.message);
    return false;
  }
}

async function commutaOpzione(chiave, messaggioAttiva, messaggioDisattiva) {
  impostazioni[chiave] = !impostazioni[chiave];
  if (!(await scriviOpzioniTv())) impostazioni[chiave] = !impostazioni[chiave];
  else toast(impostazioni[chiave] ? messaggioAttiva : messaggioDisattiva);
  salvaImpostazioni();
  aggiornaPannello();
}

async function ripristinaLg() {
  impostazioni.home = false;
  impostazioni.accensione = false;
  impostazioni.salvaschermoLg = false;
  if (await scriviOpzioniTv()) toast('Home, accensione e salvaschermo tornano quelli LG');
  salvaImpostazioni();
  await leggiOpzioniTv(); // "imposta 0" rimette anche la Home LG, se era stata rimossa
  aggiornaPannello();
}

// Tre modi per la Home: LG, dashboard (con la Home LG di riserva), solo dashboard (Home LG rimossa dal sistema)
const MODI_HOME = {
  lg: { nome: 'Home LG', nota: 'Il tasto Home apre la Home LG.' },
  dashboard: { nome: 'dashboard', nota: 'Premi Home due volte di seguito per la Home LG.' },
  solo: { nome: 'solo dashboard', nota: 'Home LG rimossa dal sistema (si rimette da qui o con l\'app Home LG).' },
};
const modoHome = () => (impostazioni.homeRimossa ? 'solo' : impostazioni.home ? 'dashboard' : 'lg');

async function scegliHome() {
  const attuale = modoHome();
  const v = await scegli('Home della TV', [
    { etichetta: 'Home LG', valore: 'lg', attiva: attuale === 'lg' },
    { etichetta: 'Dashboard, con la Home LG di riserva', valore: 'dashboard', attiva: attuale === 'dashboard' },
    { etichetta: 'Solo dashboard: rimuovi la Home LG', valore: 'solo', attiva: attuale === 'solo' },
    { etichetta: 'Annulla', valore: null },
  ]);
  if (!v || v === attuale) return;
  try {
    if (IS_WEBOS) {
      // "imposta" con la dashboard non più Home rimette da solo la Home LG
      if (v === 'solo') await servizio('rimuovi-home');
      else {
        if (attuale === 'solo') await servizio('ripristina-home');
        impostazioni.home = v === 'dashboard';
        if (!(await scriviOpzioniTv())) return;
      }
    }
    impostazioni.home = v !== 'lg';
    impostazioni.homeRimossa = v === 'solo';
    salvaImpostazioni();
    toast(v === 'solo' ? 'Home LG rimossa: la Home è solo la dashboard'
      : v === 'dashboard' ? 'Home: dashboard (Home due volte per la Home LG)' : 'Il tasto Home apre di nuovo la Home LG');
  } catch (e) {
    toast('Non riuscito: ' + e.message);
  }
  await leggiOpzioniTv();
  aggiornaPannello();
}

// Aggiornamenti del firmware LG: un aggiornamento farebbe perdere il root, quindi di norma bloccati
async function commutaAggiornamenti() {
  const bloccati = impostazioni.aggiornamentiBloccati;
  if (bloccati) {
    const ok = await scegli('Consentire gli aggiornamenti LG? Un aggiornamento farebbe perdere il root', [
      { etichetta: 'No, lasciali bloccati', valore: null },
      { etichetta: 'Sì, consentili (dal prossimo riavvio)', valore: true },
    ]);
    if (!ok) return;
  }
  try {
    if (IS_WEBOS) await servizio('aggiornamenti ' + (bloccati ? 'sblocca' : 'blocca'));
    impostazioni.aggiornamentiBloccati = !bloccati;
    toast(bloccati ? 'Aggiornamenti LG consentiti dal prossimo riavvio' : 'Aggiornamenti LG bloccati');
  } catch (e) {
    toast('Non riuscito: ' + e.message);
  }
  await leggiOpzioniTv();
  aggiornaPannello();
}

// Menu "Sistema LG": aggiornamenti e app che LG precarica di nascosto (Prime Video e browser: ~140 MB;
// Netflix no: LG la ricarica subito)
async function scegliSistemaLg() {
  for (;;) {
    const v = await scegli('Sistema LG', [
      { etichetta: 'Aggiornamenti LG: ' + (impostazioni.aggiornamentiBloccati ? 'bloccati' : 'consentiti'), valore: 'aggiornamenti' },
      { etichetta: 'Chiudi le app che LG precarica (Prime Video, browser): ' + siNo(impostazioni.alleggerisci), valore: 'precaricate' },
      { etichetta: 'Fatto', valore: 'fatto' },
    ]);
    if (!v || v === 'fatto') break;
    if (v === 'aggiornamenti') await commutaAggiornamenti();
    if (v === 'precaricate') {
      const attiva = !impostazioni.alleggerisci;
      try {
        if (IS_WEBOS) await servizio('alleggerisci ' + (attiva ? 'on' : 'off'));
        impostazioni.alleggerisci = attiva;
        toast(attiva ? 'Le app precaricate da LG verranno chiuse (si aprono comunque, solo un po\' più lente)' : 'LG torna a precaricare le app');
      } catch (e) {
        toast('Non riuscito: ' + e.message);
      }
      await leggiOpzioniTv();
      aggiornaPannello();
    }
  }
}

async function apriHomeLg() {
  if (!IS_WEBOS) { toast('Home LG (simulato)'); return; }
  try {
    await servizio('home-lg');
  } catch (e) {
    toast('Impossibile aprire la Home LG: ' + e.message);
  }
}

// ---------- Pannello impostazioni ----------

let focusPrimaImpostazioni = null;
const siNo = (v) => (v ? 'Sì' : 'No');

function aggiornaPannello() {
  $('#btn-secondi').textContent = 'Mostra i secondi: ' + siNo(impostazioni.secondi);
  $('#btn-sfondi').textContent = descriviSfondi();
  $('#btn-home').textContent = 'Home: ' + MODI_HOME[modoHome()].nome;
  $('#nota-home').textContent = MODI_HOME[modoHome()].nota;
  // Con la Home LG rimossa il pulsante "Home LG" in alto non avrebbe dove andare
  $('#btn-home-lg').style.display = impostazioni.homeRimossa ? 'none' : '';
  $('#btn-accensione').textContent = "Apri all'accensione della TV: " + siNo(impostazioni.accensione);
  $('#btn-salvaschermo').textContent = 'Salvaschermo della dashboard: ' +
    (impostazioni.salvaschermoMin ? `dopo ${impostazioni.salvaschermoMin} min` : 'mai');
  $('#btn-salvaschermo-lg').textContent = 'Sostituisci il salvaschermo LG: ' + siNo(impostazioni.salvaschermoLg);
  // Testo corto: il pulsante deve stare su una riga (il pannello è pieno)
  $('#btn-aggiornamenti').textContent = impostazioni.aggiornamentiBloccati
    ? (impostazioni.alleggerisci ? 'Sistema LG: niente aggiornamenti né precarico' : 'Sistema LG: aggiornamenti bloccati')
    : 'Sistema LG: aggiornamenti consentiti' + (impostazioni.alleggerisci ? ', niente precarico' : '');
  $('#btn-aggiornamenti').classList.toggle('avviso', !impostazioni.aggiornamentiBloccati);
  $('#btn-preferite').textContent = `App preferite nella barra: ${(impostazioni.preferite || []).length}`;
  $('#btn-wol-ingresso').textContent = "Accendilo scegliendo l'ingresso: " +
    (impostazioni.wolIngresso ? impostazioni.wolIngressoNome || nomeIngresso(impostazioni.wolIngresso) : 'nessuno');
  $('#btn-wol-pulsante').textContent = `Pulsante "Accendi ${nomeWol()}" tra i comandi: ` + siNo(impostazioni.wolPulsante);
  $('#btn-web').textContent = 'Pagina web: ' + siNo(impostazioni.web);
  $('#indirizzo-configura').textContent = impostazioni.web ? 'Da PC o telefono: ' + indirizzoWeb() : 'Configurazione da PC o telefono spenta';
}

function indirizzoWeb() {
  const ip = ($('#ip').textContent || '').trim();
  return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? `http://${ip}:${PORTA_CONFIGURA}` : `porta ${PORTA_CONFIGURA} della TV`;
}

// Pagina web di configurazione (configura.py): la accende o spegne servizio.sh
async function commutaWeb() {
  const attiva = !impostazioni.web;
  if (IS_WEBOS) {
    try {
      await servizio('web ' + (attiva ? 'on' : 'off'));
    } catch (e) {
      toast('Non riuscito: ' + e.message);
      return;
    }
  }
  impostazioni.web = attiva;
  salvaImpostazioni();
  aggiornaPannello();
  toast(attiva ? 'Pagina web attiva tra pochi secondi: ' + indirizzoWeb() : 'Pagina web spenta');
}

// Campi di testo del pannello (non quello in cui si sta scrivendo)
function riempiCampiPannello() {
  [['#input-citta', impostazioni.citta], ['#input-wol-nome', impostazioni.wolNome], ['#input-wol-mac', impostazioni.wolMac]]
    .forEach(([sel, valore]) => { if (document.activeElement !== $(sel)) $(sel).value = valore || ''; });
}

function apriImpostazioni() {
  focusPrimaImpostazioni = document.activeElement;
  riempiCampiPannello();
  $('#esito-citta').textContent = '';
  $('#esito-citta').classList.remove('errore');
  mostraEsitoWol();
  aggiornaPannello();
  $('#impostazioni').hidden = false;
  focalizza($('#btn-chiudi'));
}

// Impostazioni cambiate da fuori (pagina web di configurazione): rilegge il file e ridisegna ciò che serve
async function ricaricaImpostazioni() {
  const prima = impostazioni;
  const cambiate = await leggiFileImpostazioni();
  await leggiOpzioniTv();
  if (!cambiate) return;
  if (prima.lat !== impostazioni.lat || prima.lon !== impostazioni.lon) aggiornaMeteo();
  if (JSON.stringify(prima.preferite) !== JSON.stringify(impostazioni.preferite) && !tileInSpostamento) disegnaApp();
  if (JSON.stringify([prima.sfondi, prima.sfondoMin]) !== JSON.stringify([impostazioni.sfondi, impostazioni.sfondoMin])) applicaSfondi(true);
  aggiornaOrologio();
  aggiornaWolUI();
  aggiornaPannello();
  if (!$('#impostazioni').hidden) {
    riempiCampiPannello();
    mostraEsitoWol();
  }
}

function chiudiImpostazioni() {
  $('#impostazioni').hidden = true;
  if (focusPrimaImpostazioni && document.contains(focusPrimaImpostazioni)) focusPrimaImpostazioni.focus({ preventScroll: true });
}

async function cercaCittaDaPannello() {
  const esito = $('#esito-citta');
  const nome = $('#input-citta').value.trim();
  if (!nome) return;
  esito.classList.remove('errore');
  esito.textContent = 'Ricerca in corso…';
  try {
    const r = await cercaCitta(nome);
    impostazioni.citta = r.name;
    impostazioni.lat = r.latitude;
    impostazioni.lon = r.longitude;
    salvaImpostazioni();
    esito.textContent = 'Impostata: ' + [r.name, r.admin1, r.country].filter(Boolean).join(', ');
    $('#input-citta').value = r.name;
    focalizza($('#btn-chiudi'));
    aggiornaMeteo();
  } catch (e) {
    esito.classList.add('errore');
    esito.textContent = e.message;
  }
}

function mostraEsitoWol(testo, errore) {
  const esito = $('#esito-wol');
  esito.classList.toggle('errore', !!errore);
  esito.textContent = testo || (impostazioni.wolMac
    ? `${nomeWol()} · ${impostazioni.wolMac}`
    : 'Scrivi il MAC del PC (o di un altro dispositivo) per poterlo accendere dalla TV.');
}

// Salva nome e MAC scritti nel pannello; false se il MAC non è valido
function salvaWolDaPannello() {
  const testoMac = $('#input-wol-mac').value.trim();
  const mac = normalizzaMac(testoMac);
  if (testoMac && !mac) {
    mostraEsitoWol('MAC non valido: servono 12 cifre esadecimali, es. 00:11:22:33:44:55', true);
    return false;
  }
  impostazioni.wolNome = $('#input-wol-nome').value.trim();
  impostazioni.wolMac = mac;
  salvaImpostazioni();
  $('#input-wol-mac').value = mac;
  mostraEsitoWol(mac ? `Salvato: ${nomeWol()} · ${mac}` : 'Nessun MAC: accensione a distanza spenta');
  aggiornaPannello();
  aggiornaWolUI();
  return true;
}

async function provaWol() {
  if (!salvaWolDaPannello()) return;
  if (!impostazioni.wolMac) { mostraEsitoWol('Scrivi prima il MAC', true); return; }
  mostraEsitoWol('Invio in corso…');
  const ok = await inviaWol();
  mostraEsitoWol(ok ? `Pacchetto inviato a ${nomeWol()}: se è configurato, si sta accendendo` : 'Invio non riuscito', !ok);
}

async function scegliIngressoWol() {
  const ingressi = await elencoIngressi();
  const v = await scegli(`Accendi ${nomeWol()} quando scegli…`, [
    { etichetta: 'Nessun ingresso (solo col pulsante)', valore: '', attiva: !impostazioni.wolIngresso },
    ...ingressi.map((i) => ({ etichetta: i.etichetta, valore: i.valore, attiva: i.valore === impostazioni.wolIngresso })),
    { etichetta: 'Annulla', valore: null },
  ]);
  if (v === null) return;
  const scelto = ingressi.find((i) => i.valore === v);
  impostazioni.wolIngresso = v;
  impostazioni.wolIngressoNome = scelto ? scelto.nome : '';
  salvaImpostazioni();
  aggiornaPannello();
  if (v && !impostazioni.wolMac) mostraEsitoWol('Ingresso salvato: ora scrivi il MAC', true);
}

async function scegliMinutiSalvaschermo() {
  const v = await scegli('Salvaschermo della dashboard', [
    { etichetta: 'Mai', valore: '0', attiva: !impostazioni.salvaschermoMin },
    ...[5, 10, 15, 30, 60].map((m) => ({ etichetta: `Dopo ${m} minuti`, valore: String(m), attiva: impostazioni.salvaschermoMin === m })),
    { etichetta: 'Annulla', valore: null },
  ]);
  if (v === null) return;
  impostazioni.salvaschermoMin = Number(v);
  salvaImpostazioni();
  aggiornaPannello();
}

$('#btn-impostazioni').addEventListener('click', apriImpostazioni);
$('#btn-chiudi').addEventListener('click', chiudiImpostazioni);
$('#btn-cerca').addEventListener('click', cercaCittaDaPannello);
$('#btn-schermo').addEventListener('click', spegniSchermo);
$('#btn-home-lg').addEventListener('click', apriHomeLg);
$('#btn-aggiorna').addEventListener('click', () => {
  aggiornaMeteo();
  aggiornaSistema();
  caricaApp();
  aggiornaTv();
  aggiornaCasa();
  pilaFilm = pilaFilm.slice(0, 1);
  aggiornaFilm();
  toast('Aggiornato');
});
$('#btn-secondi').addEventListener('click', () => {
  impostazioni.secondi = !impostazioni.secondi;
  salvaImpostazioni();
  aggiornaPannello();
  aggiornaOrologio();
});
$('#btn-home').addEventListener('click', scegliHome);
$('#btn-sfondi').addEventListener('click', scegliSfondi);
$('#btn-aggiornamenti').addEventListener('click', scegliSistemaLg);
$('#btn-accensione').addEventListener('click', () => commutaOpzione('accensione',
  "La dashboard si aprirà all'accensione", "All'accensione torna il comportamento LG"));
$('#btn-salvaschermo-lg').addEventListener('click', () => commutaOpzione('salvaschermoLg',
  'Il salvaschermo LG sarà sostituito dalla dashboard', 'Torna il salvaschermo LG'));
$('#btn-salvaschermo').addEventListener('click', scegliMinutiSalvaschermo);
$('#btn-ripristina-lg').addEventListener('click', ripristinaLg);
$('#btn-preferite').addEventListener('click', () => {
  chiudiImpostazioni();
  apriScegliPreferite();
});
$('#btn-preferite-fine').addEventListener('click', chiudiScegliPreferite);
['#input-wol-nome', '#input-wol-mac'].forEach((s) => $(s).addEventListener('change', salvaWolDaPannello));
$('#btn-wol-prova').addEventListener('click', provaWol);
$('#btn-web').addEventListener('click', commutaWeb);
$('#btn-wol-ingresso').addEventListener('click', scegliIngressoWol);
$('#btn-wol-pulsante').addEventListener('click', () => {
  impostazioni.wolPulsante = !impostazioni.wolPulsante;
  salvaImpostazioni();
  aggiornaPannello();
  aggiornaWolUI();
});

// ---------- Salvaschermo e protezione OLED ----------

const SPOSTAMENTO_SALVASCHERMO = 60 * 1000;
const SPOSTAMENTO_ANTI_BURN_IN = 3 * 60 * 1000;

let salvaschermoAttivo = false;
let ultimaAttivita = Date.now();
let timerSalvaschermo = null;

function attivaSalvaschermo() {
  if (salvaschermoAttivo) return;
  salvaschermoAttivo = true;
  terminaSpostamento();
  chiudiScelta(null);
  if (!$('#scegli-preferite').hidden) chiudiScegliPreferite();
  aggiornaMeteoSalvaschermo();
  $('#salvaschermo').hidden = false;
  sfondoSalvaschermo(true);
  aggiornaOrologio();
  spostaSalvaschermo();
  timerSalvaschermo = setInterval(spostaSalvaschermo, SPOSTAMENTO_SALVASCHERMO);
}

function disattivaSalvaschermo() {
  if (!salvaschermoAttivo) return;
  salvaschermoAttivo = false;
  clearInterval(timerSalvaschermo);
  $('#salvaschermo').hidden = true;
  sfondoSalvaschermo(false);
  ultimaAttivita = Date.now();
}

function aggiornaMeteoSalvaschermo() {
  $('#ss-meteo').innerHTML = ultimoMeteo
    ? `${icona(ultimoMeteo.icona)}<span>${ultimoMeteo.temperatura}° ${ultimoMeteo.descrizione}</span>` : '';
}

// Posizione casuale ogni minuto: niente pixel accesi sempre nello stesso punto
function spostaSalvaschermo() {
  const c = $('.ss-contenuto');
  const w = Math.max(0, window.innerWidth - c.offsetWidth);
  const h = Math.max(0, window.innerHeight - c.offsetHeight);
  c.style.left = Math.round(Math.random() * w) + 'px';
  c.style.top = Math.round(Math.random() * h) + 'px';
}

// Sulla dashboard normale: piccolo spostamento periodico di tutto il contenuto
function spostamentoAntiBurnIn() {
  const x = Math.round(Math.random() * 12 - 6);
  const y = Math.round(Math.random() * 12 - 6);
  $('#pagine').style.translate = `${x}px ${y}px`;
}

function controllaInattivita() {
  if (salvaschermoAttivo || document.hidden || !impostazioni.salvaschermoMin) return;
  if (Date.now() - ultimaAttivita >= impostazioni.salvaschermoMin * 60000) attivaSalvaschermo();
}

function parametriAvvio() {
  if (!IS_WEBOS) return { salvaschermo: new URLSearchParams(location.search).has('salvaschermo') };
  try {
    return JSON.parse((window.PalmSystem && window.PalmSystem.launchParams) || '{}') || {};
  } catch (e) {
    return {};
  }
}

function applicaParametriAvvio() {
  if (parametriAvvio().salvaschermo) {
    attivaSalvaschermo();
  } else {
    disattivaSalvaschermo();
    // Aperta dal tasto Home o dal launcher: si riparte dalla panoramica
    if (!overlayAttivo() && paginaCorrente !== 0) {
      const t = $('#riga-app .tile');
      if (t) focalizza(t);
    }
  }
}

// ---------- Tasti del telecomando ----------

let timerPressione = null;
// Dopo una pressione lunga OK resta premuto: le ripetizioni del tasto non devono scegliere una voce del menu
let attendiRilascioOk = false;

// Ultimo ingresso o app usati prima della dashboard (cronologia aggiornata del servizio)
async function sorgentePrecedente() {
  // L'app Film esce verso la dashboard: tornarci con Indietro farebbe un giro tra le due
  const escluse = new Set([...ESCLUSE, APP_ID + '.film', ...(config.homeIds || []), ...(config.salvaschermoIds || [])]);
  const out = await sh(`tail -n 30 ${FILE_RECENTI} 2>/dev/null`);
  const ids = out.split('\n').map((r) => r.trim().split(' ')[1]).filter(Boolean).reverse();
  return ids.find((id) => !escluse.has(id)) || null;
}

async function esci() {
  // Indietro torna alla sorgente di prima (Live TV, HDMI, app), non alla Home LG
  try {
    const precedente = await sorgentePrecedente();
    if (precedente) {
      await lunaConFallback('luna://com.webos.applicationManager/launch', { id: precedente });
      return;
    }
  } catch (e) { /* si esce e basta */ }
  // Con la dashboard come Home, la Home LG che compare dopo l'uscita non va reindirizzata
  if (impostazioni.home) {
    try { await servizio('salta-home'); } catch (e) { /* esce comunque */ }
  }
  window.close();
}

function indietro() {
  if (!$('#scelta').hidden) { chiudiScelta(null); return; }
  if (!$('#scegli-preferite').hidden) { chiudiScegliPreferite(); return; }
  if (!$('#impostazioni').hidden) { chiudiImpostazioni(); return; }
  // Nella card Film, Indietro risale di una cartella
  if (document.activeElement && document.activeElement.closest('#film-lista') && cartellaSuFilm()) return;
  if (paginaCorrente > 0) {
    const t = $('#riga-app .tile');
    if (t) focalizza(t);
    else mostraPagina(0);
    return;
  }
  if (IS_WEBOS) esci();
}

document.addEventListener('keydown', (e) => {
  ultimaAttivita = Date.now();
  if (salvaschermoAttivo) {
    e.preventDefault();
    if (!e.repeat) disattivaSalvaschermo();
    return;
  }
  if (e.keyCode === KEY.ENTER && attendiRilascioOk) {
    e.preventDefault();
    return;
  }
  attendiRilascioOk = false; // un altro tasto: OK è stato rilasciato anche se il keyup non è arrivato

  const attivo = document.activeElement;
  const inInput = attivo && attivo.tagName === 'INPUT';
  // Nei campi di testo ◀ ▶ spostano il cursore; dal bordo del testo passano al campo o pulsante accanto
  const alBordo = (verso) => inInput && (verso < 0
    ? attivo.selectionStart === 0 && attivo.selectionEnd === 0
    : attivo.selectionStart === attivo.value.length);

  if (tileInSpostamento) {
    e.preventDefault();
    if (e.keyCode === KEY.LEFT) spostaTile(-1);
    else if (e.keyCode === KEY.RIGHT) spostaTile(1);
    else if ([KEY.ENTER, KEY.BACK, KEY.ESC].includes(e.keyCode) && !e.repeat) terminaSpostamento();
    return;
  }

  switch (e.keyCode) {
    case KEY.LEFT: if (!inInput || alBordo(-1)) { muovi('sinistra'); e.preventDefault(); } break;
    case KEY.RIGHT: if (!inInput || alBordo(1)) { muovi('destra'); e.preventDefault(); } break;
    case KEY.UP: muovi('su'); e.preventDefault(); break;
    case KEY.DOWN: muovi('giu'); e.preventDefault(); break;
    case KEY.ENTER:
      if (inInput) {
        if (attivo.id === 'input-citta') cercaCittaDaPannello();
        else salvaWolDaPannello();
        e.preventDefault();
      } else if (attivo && ['tile-app', 'tile-lancio', 'tile-preferita'].some((c) => attivo.classList.contains(c))) {
        // OK breve apre l'app (al rilascio), OK tenuto premuto apre il menu
        e.preventDefault();
        if (!e.repeat && !timerPressione) {
          timerPressione = setTimeout(() => {
            timerPressione = null;
            attendiRilascioOk = true;
            menuTile(attivo);
          }, DURATA_PRESSIONE_LUNGA);
        }
      }
      break;
    case KEY.BACK:
    case KEY.ESC:
      e.preventDefault();
      indietro();
      break;
    default:
  }
});

document.addEventListener('keyup', (e) => {
  if (e.keyCode === KEY.ENTER && attendiRilascioOk) {
    attendiRilascioOk = false;
    e.preventDefault();
    return;
  }
  if (e.keyCode === KEY.ENTER && timerPressione) {
    clearTimeout(timerPressione);
    timerPressione = null;
    if (document.activeElement) document.activeElement.click();
  }
});

// Magic Remote: il puntatore sposta il focus ed esce dal salvaschermo
document.addEventListener('mousemove', (e) => {
  if (Math.abs(e.movementX) + Math.abs(e.movementY) < 3) return;
  ultimaAttivita = Date.now();
  if (salvaschermoAttivo) disattivaSalvaschermo();
});
document.addEventListener('mouseover', (e) => {
  if (tileInSpostamento || salvaschermoAttivo) return;
  // Dopo la rotella la lista scorre sotto il puntatore fermo: non deve rubare il focus
  if (Date.now() - ultimaRotella < 500) return;
  const el = e.target.closest && e.target.closest('.focusable');
  if (el && el.tagName !== 'INPUT' && elementiNavigabili().includes(el)) el.focus({ preventScroll: true });
});

// ---------- Scala per l'anteprima fuori dalla TV ----------

function adattaScala() {
  const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  $('#schermo').style.transform = s === 1 ? '' : `scale(${s})`;
}
window.addEventListener('resize', adattaScala);

// ---------- Avvio ----------

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { terminaSpostamento(); return; }
  ultimaAttivita = Date.now();
  ricaricaImpostazioni();
  aggiornaSistema();
  caricaApp();
  aggiornaTv();
  leggiTimer();
});
// L'app viene riattivata (non riavviata) quando la si riapre dal launcher, da Home o dal servizio
document.addEventListener('webOSRelaunch', () => {
  // configura.py ha salvato nuove impostazioni mentre la dashboard era davanti: solo da rileggere
  if (parametriAvvio().ricarica) { ricaricaImpostazioni(); return; }
  applicaParametriAvvio();
  caricaApp();
});

(async function avvia() {
  adattaScala();
  creaControlli();
  aggiornaSuggerimento();
  aggiornaOrologio();
  setInterval(aggiornaOrologio, 1000);
  applicaParametriAvvio();

  await caricaConfig();
  await leggiFileImpostazioni();
  aggiornaWolUI();
  applicaSfondi();

  aggiornaMeteo();
  caricaInfoTv();
  aggiornaSistema();
  setInterval(aggiornaSistema, INTERVALLO_SISTEMA);
  caricaApp();
  aggiornaTv();
  setInterval(() => { if (!document.hidden) aggiornaTv(); }, INTERVALLO_TV);
  aggiornaCasa();
  setInterval(() => { if (!document.hidden) aggiornaCasa(); }, INTERVALLO_CASA);
  aggiornaFilm();
  setInterval(() => { if (!document.hidden) aggiornaFilm(); }, INTERVALLO_FILM);
  leggiOpzioniTv();
  leggiTimer();

  setInterval(controllaInattivita, 15 * 1000);
  setInterval(spostamentoAntiBurnIn, SPOSTAMENTO_ANTI_BURN_IN);
}());
