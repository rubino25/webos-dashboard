'use strict';

// Barra delle app: recenti (ultimo ingresso, ultime app) e app preferite, scelte e ordinate dall'utente

const DURATA_PRESSIONE_LUNGA = 600;
const FILE_RECENTI = '/var/lib/webosbrew/dashboard/recenti.txt';

const PREFERITE_INIZIALI = 8;

let puntiAvvio = [];   // tutte le app del launcher, nell'ordine del launcher
let recenti = [];      // id usati, dal più recente

const APP_DEMO = [
  { id: 'com.webos.app.livetv', title: 'Live TV', bgColor: '#e5383b' },
  { id: 'netflix', title: 'Netflix', bgColor: '#141414', removable: true },
  { id: 'youtube.leanback.v4', title: 'YouTube', bgColor: '#ff0000', removable: true },
  { id: 'amazon', title: 'Prime Video', bgColor: '#00a8e1', removable: true },
  { id: 'com.disney.disneyplus-prod', title: 'Disney+', bgColor: '#113ccf', removable: true },
  { id: 'spotify-beehive', title: 'Spotify', bgColor: '#1db954', removable: true },
  { id: 'org.webosbrew.hbchannel', title: 'Homebrew Channel', bgColor: '#3b3b98' },
  { id: 'com.webos.app.browser', title: 'Browser', bgColor: '#4263eb' },
  { id: 'com.webos.app.settings', title: 'Impostazioni TV', bgColor: '#495057' },
];
const RECENTI_DEMO = ['spotify-beehive', 'netflix', 'com.webos.app.hdmi2', 'youtube.leanback.v4'];

// Gli ingressi sono "app" di sistema: HDMI, Live TV, AV, componente
const INGRESSO = /^com\.webos\.app\.(hdmi\d+|livetv|externalinput\.\w+|comp\w*|av\d*)$/;
// Schermate di sistema da non considerare come "ultima app"
const ESCLUSE = new Set([APP_ID, APP_ID + '.homelg', 'com.webos.app.home', 'com.webos.app.launcher', 'com.webos.app.voice',
  'com.webos.app.notificationcenter', 'com.webos.app.inputcommon', 'com.webos.app.screensaver']);

const chiavePunto = (p) => p.launchPointId || p.id;

function nomeIngresso(id) {
  const hdmi = id.match(/hdmi(\d+)$/);
  if (hdmi) return 'HDMI ' + hdmi[1];
  if (/livetv$/.test(id)) return 'Live TV';
  return maiuscola(id.replace(/^com\.webos\.app\.(externalinput\.)?/, ''));
}

async function caricaApp() {
  const stato = $('#app-stato');
  try {
    const r = IS_WEBOS
      ? await lunaConFallback('luna://com.webos.applicationManager/listLaunchPoints', {})
      : { launchPoints: APP_DEMO };
    puntiAvvio = (r.launchPoints || []).filter((p) => p.id !== APP_ID);
    inizializzaPreferite();
    stato.textContent = '';
    if (IS_WEBOS) await copiaIcone(puntiAvvio);
  } catch (e) {
    puntiAvvio = [];
    stato.textContent = 'Impossibile leggere le app: ' + e.message;
  }
  await caricaRecenti();
  disegnaApp();
  const ingresso = recenti.find((id) => INGRESSO.test(id));
  $('#ctl-ingresso-valore').textContent = ingresso ? nomeIngresso(ingresso) : '';
  $('#ctl-app-valore').textContent = puntiAvvio.length ? `${puntiAvvio.length} app` : '';
  leggiImmagine();
}

// webOS non lascia leggere a un'app web i file delle altre app: le icone vengono copiate
// da root nella cartella della dashboard (icone/) e caricate da lì. Si rifà dopo ogni aggiornamento.
async function copiaIcone(punti) {
  const righe = [];
  punti.forEach((p) => {
    if (!p.icon || /^https?:/.test(p.icon)) return;
    const sorgente = p.icon.replace(/^file:\/\//, '');
    const estensione = (sorgente.match(/\.(png|jpe?g|webp|svg)$/i) || ['', 'png'])[1];
    p.iconaLocale = 'icone/' + chiavePunto(p).replace(/[^A-Za-z0-9._-]/g, '_') + '.' + estensione;
    righe.push(`c ${shQuote(sorgente)} ${shQuote(p.iconaLocale)}`);
  });
  if (!righe.length) return;
  try {
    await sh(`cd ${shQuote(cartellaApp())} && mkdir -p icone && ` +
      `c() { [ -s "$2" ] || cp "$1" "$2" 2>/dev/null; }\n${righe.join('\n')}`);
  } catch (e) { /* restano le iniziali */ }
}

// Avvia il servizio se non gira (es. primo avvio) e legge la cronologia, più recente per prima
async function caricaRecenti() {
  if (!IS_WEBOS) { recenti = RECENTI_DEMO; return; }
  try {
    const out = await sh(`sh ${shQuote(cartellaApp() + '/servizio.sh')} start >/dev/null 2>&1; tail -n 50 ${FILE_RECENTI} 2>/dev/null`);
    recenti = out.split('\n').map((r) => r.trim().split(' ')[1]).filter(Boolean).reverse();
  } catch (e) {
    recenti = [];
  }
}

// Prima volta: le prime app nell'ordine che c'era (senza le nascoste), poi le sceglie l'utente
function inizializzaPreferite() {
  if (Array.isArray(impostazioni.preferite) || !puntiAvvio.length) return;
  const nascoste = new Set(impostazioni.nascoste || []);
  impostazioni.preferite = ordinaPunti(puntiAvvio).map(chiavePunto).filter((k) => !nascoste.has(k)).slice(0, PREFERITE_INIZIALI);
  salvaImpostazioni();
}

function appPreferite() {
  const perChiave = new Map(puntiAvvio.map((p) => [chiavePunto(p), p]));
  return (impostazioni.preferite || []).map((k) => perChiave.get(k)).filter(Boolean);
}

function tileRecenti() {
  const perId = new Map(puntiAvvio.map((p) => [p.id, p]));
  const escluse = new Set([...ESCLUSE, ...(config.homeIds || []), ...(config.salvaschermoIds || [])]);
  const out = [];

  const ingresso = recenti.find((id) => INGRESSO.test(id));
  if (ingresso) {
    const p = perId.get(ingresso) || { id: ingresso, title: nomeIngresso(ingresso), bgColor: '#2b3a67' };
    out.push({ punto: p, etichetta: 'Ultimo ingresso' });
  }

  const app = [];
  recenti.forEach((id) => {
    if (INGRESSO.test(id) || escluse.has(id) || !perId.has(id) || app.includes(id)) return;
    app.push(id);
  });
  if (app[0]) out.push({ punto: perId.get(app[0]), etichetta: 'Ultima app' });
  if (app[1]) out.push({ punto: perId.get(app[1]), etichetta: 'App precedente' });
  return out;
}

function ordinaPunti(punti) {
  const posizione = new Map((impostazioni.ordine || []).map((id, i) => [id, i]));
  // Le app nuove (non ancora ordinate) finiscono in coda nell'ordine del launcher
  return punti
    .map((p, i) => ({ p, k: posizione.has(chiavePunto(p)) ? posizione.get(chiavePunto(p)) : posizione.size + i }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.p);
}

function creaTile(p, classe, etichetta, azione) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'focusable tile ' + classe;
  tile.dataset.punto = chiavePunto(p);

  if (etichetta) {
    const e = document.createElement('span');
    e.className = 'tile-etichetta';
    e.textContent = etichetta;
    tile.appendChild(e);
  }

  const iconaEl = document.createElement('span');
  iconaEl.className = 'tile-icona';
  iconaEl.style.background = p.bgColor || 'rgba(255,255,255,0.1)';
  const lettera = () => { iconaEl.textContent = (p.title || '?').charAt(0).toUpperCase(); };
  if (p.icon) {
    const img = document.createElement('img');
    img.src = p.iconaLocale || (/^(file|https?):/.test(p.icon) ? p.icon : 'file://' + p.icon);
    img.alt = '';
    img.onerror = () => { img.remove(); lettera(); };
    iconaEl.appendChild(img);
  } else {
    lettera();
  }

  const nome = document.createElement('span');
  nome.className = 'tile-nome';
  nome.textContent = p.title || p.id;

  tile.append(iconaEl, nome);
  tile.addEventListener('click', () => (azione ? azione(tile) : avviaApp(p)));
  return tile;
}

// chiaveFocus: tile da selezionare dopo il ridisegno (altrimenti quella che aveva il focus)
function disegnaApp(chiaveFocus) {
  const riga = $('#riga-app');
  const attivo = document.activeElement;
  const chiave = chiaveFocus || (attivo && attivo.dataset.punto);
  const selettore = !chiaveFocus && attivo && attivo.classList.contains('tile-recente') ? '.tile-recente' : '.tile-app, .tile-scegli';
  const aveFocus = riga.contains(attivo) || !!chiaveFocus;
  riga.querySelectorAll('.tile, .separatore').forEach((el) => el.remove());

  const stato = $('#app-stato');
  const recentiTile = tileRecenti();
  recentiTile.forEach((r) => riga.insertBefore(creaTile(r.punto, 'tile-recente', r.etichetta), stato));
  if (recentiTile.length) {
    const sep = document.createElement('div');
    sep.className = 'separatore';
    riga.insertBefore(sep, stato);
  }
  appPreferite().forEach((p) => riga.insertBefore(creaTile(p, 'tile-app'), stato));
  riga.insertBefore(creaTile({ id: 'scegli', title: 'Scegli app', bgColor: 'rgba(122, 162, 255, 0.16)' },
    'tile-scegli', null, apriScegliPreferite), stato);
  riga.querySelector('.tile-scegli .tile-icona').textContent = '+';

  const daFocalizzare = chiave && Array.from(riga.querySelectorAll(selettore)).find((t) => t.dataset.punto === chiave);
  if (daFocalizzare && aveFocus) focalizza(daFocalizzare);
  else if (aveFocus || !document.activeElement || document.activeElement === document.body) {
    const primo = riga.querySelector('.tile');
    if (primo) focalizza(primo);
  }
}

async function avviaApp(p) {
  wolPerIngresso(p.id);
  if (!IS_WEBOS) { toast('Avvio di ' + p.title + ' (simulato)'); return; }
  const params = p.params ? { id: p.id, params: p.params } : { id: p.id };
  try {
    await lunaConFallback('luna://com.webos.applicationManager/launch', params);
  } catch (e) {
    toast('Impossibile aprire ' + p.title + ': ' + e.message);
  }
}

// ---------- Menu della tile (OK tenuto premuto) ----------

async function menuTile(tile) {
  const chiave = tile.dataset.punto;
  const p = puntiAvvio.find((x) => chiavePunto(x) === chiave);
  if (!p) return;
  const disinstalla = disinstallabile(p) ? [{ etichetta: 'Disinstalla', valore: 'disinstalla' }] : [];
  // Nella griglia "Tutte le app" / "App preferite" (OK tenuto premuto su un'app)
  if (tile.closest('#preferite-griglia')) {
    const v = await scegli(p.title || p.id, [
      { etichetta: 'Apri', valore: 'apri' },
      ...disinstalla,
      { etichetta: 'Annulla', valore: null },
    ]);
    if (v === 'apri') { chiudiScegliPreferite(); avviaApp(p); }
    if (v === 'disinstalla') await disinstallaApp(p);
    return;
  }
  const scelta = await scegli(p.title || p.id, [
    { etichetta: 'Sposta', valore: 'sposta' },
    { etichetta: 'Togli dai preferiti', valore: 'togli' },
    ...disinstalla,
    { etichetta: 'Annulla', valore: null },
  ]);
  if (scelta === 'disinstalla') {
    await disinstallaApp(p);
  } else if (scelta === 'sposta') {
    focalizza(tile);
    iniziaSpostamento(tile);
  } else if (scelta === 'togli') {
    const vicino = tile.nextElementSibling && tile.nextElementSibling.classList.contains('tile-app')
      ? tile.nextElementSibling : tile.previousElementSibling;
    impostazioni.preferite = impostazioni.preferite.filter((k) => k !== chiave);
    salvaImpostazioni();
    disegnaApp((vicino && vicino.dataset.punto) || 'scegli');
    toast(`${p.title} tolta dai preferiti: la riaggiungi con "Scegli app"`);
  }
}

// ---------- Disinstallazione ----------

// Servono alla dashboard o al root: si disinstallano dall'app stessa o da Homebrew Channel, non da qui
const NON_DISINSTALLABILI = new Set([APP_ID, APP_ID + '.homelg', 'org.webosbrew.hbchannel', 'org.webosbrew.inputhook',
  'com.tvweb.dashboard']);
// Le app di sistema LG e gli ingressi hanno removable: false
const disinstallabile = (p) => p.removable === true && !NON_DISINSTALLABILI.has(p.id) && (!p.launchPointId || p.launchPointId === p.id + '_default');

async function disinstallaApp(p) {
  const nome = p.title || p.id;
  const ok = await scegli(`Disinstallare ${nome}?`, [
    { etichetta: 'Annulla', valore: null },
    { etichetta: `Sì, disinstalla ${nome}`, valore: true },
  ]);
  if (!ok) return false;
  if (IS_WEBOS) {
    toast(`Disinstallazione di ${nome}…`);
    try {
      // App dello store in /media/cryptofs, app homebrew in /media/developer (servizio "dev")
      const sviluppo = (await sh(`[ -d /media/developer/apps/usr/palm/applications/${shQuote(p.id)} ] && echo dev`)).trim() === 'dev';
      await lunaRoot(`luna://com.webos.appInstallService/${sviluppo ? 'dev/' : ''}remove`, { id: p.id, subscribe: false });
      // La rimozione continua in background: si aspetta che il sistema non conosca più l'app (al massimo 40 s)
      let tolta = false;
      for (let i = 0; i < 40 && !tolta; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        tolta = await lunaRoot('luna://com.webos.applicationManager/getAppInfo', { id: p.id }).then(() => false, () => true);
      }
      if (!tolta) throw new Error('la TV non ha completato la rimozione');
    } catch (e) {
      toast(`Disinstallazione di ${nome} non riuscita: ${e.message}`);
      return false;
    }
  }
  impostazioni.preferite = (impostazioni.preferite || []).filter((k) => k !== chiavePunto(p));
  salvaImpostazioni();
  puntiAvvio = puntiAvvio.filter((x) => x !== p);
  if (!$('#scegli-preferite').hidden) apriGrigliaApp(modoGriglia);
  disegnaApp();
  toast(`${nome} disinstallata`);
  if (IS_WEBOS) caricaApp();
  return true;
}

// ---------- Scelta delle app preferite ----------

// La stessa griglia serve a scegliere le preferite e (pulsante "Tutte le app") ad aprire un'app
let modoGriglia = 'preferite';

function apriGrigliaApp(modo) {
  modoGriglia = modo;
  const griglia = $('#preferite-griglia');
  griglia.innerHTML = '';
  const scelte = new Set(impostazioni.preferite || []);
  const ordinate = puntiAvvio.slice().sort((x, y) => (x.title || x.id).localeCompare(y.title || y.id, 'it'));
  ordinate.forEach((p) => {
    const t = modo === 'preferite'
      ? creaTile(p, 'tile-preferita' + (scelte.has(chiavePunto(p)) ? ' scelta' : ''), null, commutaPreferita)
      : creaTile(p, 'tile-lancio', null, () => { chiudiScegliPreferite(); avviaApp(p); });
    griglia.appendChild(t);
  });
  $('#griglia-titolo').textContent = modo === 'preferite' ? 'App preferite' : 'Tutte le app';
  $('#btn-preferite-fine').textContent = modo === 'preferite' ? 'Fatto' : 'Chiudi';
  aggiornaContoPreferite();
  $('#scegli-preferite').hidden = false;
  const primo = griglia.querySelector('.tile');
  if (primo) focalizza(primo);
}

const apriScegliPreferite = () => apriGrigliaApp('preferite');
const apriTutteLeApp = () => apriGrigliaApp('apri');

function commutaPreferita(tile) {
  const chiave = tile.dataset.punto;
  const lista = impostazioni.preferite || [];
  impostazioni.preferite = lista.includes(chiave) ? lista.filter((k) => k !== chiave) : lista.concat(chiave);
  tile.classList.toggle('scelta', impostazioni.preferite.includes(chiave));
  salvaImpostazioni();
  aggiornaContoPreferite();
}

function aggiornaContoPreferite() {
  if (modoGriglia !== 'preferite') {
    $('#griglia-nota').textContent = `OK apre l'app · OK tenuto premuto per disinstallarla · ${puntiAvvio.length} app installate`;
    return;
  }
  const n = (impostazioni.preferite || []).length;
  $('#griglia-nota').textContent = "OK aggiunge o toglie un'app dalla barra · OK tenuto premuto per disinstallarla · " +
    (n === 1 ? '1 app scelta' : `${n} app scelte`);
}

function chiudiScegliPreferite() {
  $('#scegli-preferite').hidden = true;
  if (modoGriglia === 'preferite') disegnaApp('scegli');
  else if ($('#ctl-app')) focalizza($('#ctl-app'));
}

// ---------- Spostamento ----------

let tileInSpostamento = null;

function aggiornaSuggerimento() {
  $('#suggerimento').textContent = tileInSpostamento
    ? '◀ ▶ sposta · OK per confermare'
    : 'Tieni premuto OK per spostare o togliere · ▼ sistema e casa';
}

function iniziaSpostamento(tile) {
  tileInSpostamento = tile;
  tile.classList.add('spostando');
  $('#riga-app').classList.add('modalita-sposta');
  aggiornaSuggerimento();
}

function spostaTile(direzione) {
  const tile = tileInSpostamento;
  const vicino = direzione < 0 ? tile.previousElementSibling : tile.nextElementSibling;
  if (!vicino || !vicino.classList.contains('tile-app')) return;
  tile.parentNode.insertBefore(direzione < 0 ? tile : vicino, direzione < 0 ? vicino : tile);
  focalizza(tile);
}

function terminaSpostamento() {
  if (!tileInSpostamento) return;
  tileInSpostamento.classList.remove('spostando');
  $('#riga-app').classList.remove('modalita-sposta');
  tileInSpostamento = null;
  const inBarra = Array.from(document.querySelectorAll('#riga-app .tile-app')).map((t) => t.dataset.punto);
  impostazioni.preferite = inBarra.concat((impostazioni.preferite || []).filter((k) => !inBarra.includes(k)));
  salvaImpostazioni();
  aggiornaSuggerimento();
}
