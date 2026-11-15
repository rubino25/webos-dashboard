'use strict';

// App Film: vetrina in alto, "Continua a guardare", griglia di locandine con ricerca e ordinamento,
// pagina degli episodi per le serie. La riproduzione è affidata al Media Player LG.

const MEDIA_PLAYER = 'com.webos.app.mediadiscovery';
const DURATA_PRESSIONE_LUNGA = 600;
const ORDINAMENTI = [
  { id: 'recenti', nome: 'Aggiunti di recente' },
  { id: 'titolo', nome: 'Titolo A–Z' },
  { id: 'anno', nome: 'Anno' },
];
const STORAGE_ORDINE = 'film.ordine';

let ordine = 'recenti';
try { ordine = localStorage.getItem(STORAGE_ORDINE) || 'recenti'; } catch (e) { /* predefinito */ }
let serieAperta = null; // voce serie di cui si vedono gli episodi

// ---------- Formati ----------

function durataBreve(s) {
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${pad(m)} min` : `${m} min`;
}

function minutiSecondi(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(Math.floor(s % 60))}` : `${m}:${pad(Math.floor(s % 60))}`;
}

const etichettaEpisodio = (e) => (e.stagione ? `S${pad(e.stagione)}E${pad(e.episodio)}` : `${e.episodio}.`);

// ---------- Locandine ----------

function annoDi(voce) {
  const info = infoTmdb(voce);
  return voce.anno || (info && info.anno) || null;
}

function titoloDi(voce) {
  const info = infoTmdb(voce);
  return (info && info.titolo) || voce.titolo;
}

// Colore di riserva per le locandine senza immagine, sempre uguale per lo stesso titolo
function coloreDi(testo) {
  let h = 0;
  for (const c of testo) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `linear-gradient(160deg, hsl(${h} 45% 34%), hsl(${(h + 40) % 360} 50% 16%))`;
}

function creaLocandina(voce, contesto) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'focusable locandina';
  b.dataset.chiave = voce.chiave;
  b.dataset.contesto = contesto;

  const img = document.createElement('div');
  img.className = 'locandina-img';
  img.style.background = coloreDi(voce.titolo);
  const segnaposto = document.createElement('span');
  segnaposto.className = 'locandina-segnaposto';
  segnaposto.textContent = titoloDi(voce);
  img.appendChild(segnaposto);
  const url = urlLocandina(infoTmdb(voce));
  if (url) {
    const i = document.createElement('img');
    i.src = url;
    i.alt = '';
    i.onload = () => segnaposto.remove();
    i.onerror = () => i.remove();
    img.appendChild(i);
  }

  if (voce.tipo === 'serie') {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = voce.raccolta ? `${voce.episodi.length} video` : `${voce.episodi.length} ep.`;
    img.appendChild(badge);
  }
  if (vistoVoce(voce)) {
    const v = document.createElement('span');
    v.className = 'visto';
    v.textContent = '✓';
    img.appendChild(v);
  }
  // Barra di avanzamento: film in corso, o episodio da riprendere nella riga "Continua"
  const video = voce.tipo === 'film' ? voce.video : (contesto === 'continua' && prossimoEpisodio(voce) || {}).video;
  const frazione = video && !vistoVideo(video) ? avanzamento(video) : 0;
  if (frazione > 0) {
    const barra = document.createElement('span');
    barra.className = 'avanzamento';
    barra.innerHTML = `<i style="width:${Math.round(frazione * 100)}%"></i>`;
    img.appendChild(barra);
  }

  const nome = document.createElement('span');
  nome.className = 'locandina-nome';
  if (contesto === 'continua' && voce.tipo === 'serie') {
    const e = prossimoEpisodio(voce);
    nome.textContent = e ? `${titoloDi(voce)} · ${etichettaEpisodio(e)}` : titoloDi(voce);
  } else {
    nome.textContent = titoloDi(voce);
  }
  b.append(img, nome);
  b.addEventListener('click', () => scegliVoce(voce, contesto));
  b.addEventListener('focus', () => alFocus(b));
  return b;
}

// ---------- Vetrina ----------

const TRAMA_PAUSA = 4000;     // ms fermi in cima e in fondo
const TRAMA_VELOCITA = 22;    // px al secondo
let animazioneTrama = null;

// Se la trama non sta nel riquadro, scorre piano fino in fondo, si ferma e riparte dall'inizio
function impostaTrama(testo) {
  const box = $('#vetrina-trama');
  const p = $('#trama-testo');
  if (p.textContent === testo) return; // stessa trama: l'animazione continua
  if (animazioneTrama) { animazioneTrama.cancel(); animazioneTrama = null; }
  p.textContent = testo;
  const eccesso = p.offsetHeight - box.clientHeight;
  box.classList.toggle('scorre', eccesso > 4);
  if (eccesso <= 4 || !p.animate) return;
  const corsa = (eccesso + 16) / TRAMA_VELOCITA * 1000;
  const totale = TRAMA_PAUSA + corsa + TRAMA_PAUSA + 800;
  const a = (ms) => ms / totale;
  animazioneTrama = p.animate([
    { transform: 'translateY(0)', offset: 0, opacity: 1 },
    { transform: 'translateY(0)', offset: a(TRAMA_PAUSA), opacity: 1 },
    { transform: `translateY(${-(eccesso + 16)}px)`, offset: a(TRAMA_PAUSA + corsa), opacity: 1 },
    { transform: `translateY(${-(eccesso + 16)}px)`, offset: a(TRAMA_PAUSA + corsa + TRAMA_PAUSA), opacity: 1 },
    { transform: `translateY(${-(eccesso + 16)}px)`, offset: a(TRAMA_PAUSA + corsa + TRAMA_PAUSA + 400), opacity: 0 },
    { transform: 'translateY(0)', offset: 1, opacity: 1 },
  ], { duration: totale, iterations: Infinity, easing: 'linear' });
}

function mostraVetrina(voce, contesto, episodio) {
  const info = infoTmdb(voce);
  $('#vetrina-percorso').textContent = voce.tipo === 'serie' ? (voce.raccolta ? 'Raccolta' : 'Serie') : 'Film';
  $('#vetrina-titolo').textContent = titoloDi(voce);

  const dati = [];
  const anno = annoDi(voce);
  if (anno) dati.push(anno);
  if (voce.tipo === 'film') {
    if (voce.video.durata) dati.push(durataBreve(voce.video.durata));
    if (voce.video.risoluzione) dati.push(voce.video.risoluzione.replace(/^(\d+)x(\d+)$/, (m, w, h) => (Number(h) >= 1000 || Number(w) >= 1900 ? 'Full HD' : Number(h) >= 700 || Number(w) >= 1260 ? 'HD' : 'SD')));
  } else {
    const stagioni = new Set(voce.episodi.map((e) => e.stagione)).size;
    dati.push(voce.raccolta ? `${voce.episodi.length} video` : `${stagioni > 1 ? stagioni + ' stagioni · ' : ''}${voce.episodi.length} episodi`);
  }
  if (info && info.voto) dati.push(`★ ${info.voto.toFixed(1).replace('.', ',')}`);
  $('#vetrina-dati').textContent = dati.join('  ·  ');

  let trama = (info && info.trama) || '';
  if (episodio) trama = `${etichettaEpisodio(episodio)}${episodio.nome ? ' · ' + episodio.nome : ''}` + (episodio.video.durata ? ` · ${durataBreve(episodio.video.durata)}` : '');
  impostaTrama(trama || (chiaveTmdb() ? '' : 'Per locandine e trame aggiungi la chiave TMDB in config.json.'));

  const stato = [];
  const v = episodio ? episodio.video : voce.tipo === 'film' ? voce.video : null;
  if (v) {
    if (vistoVideo(v)) stato.push('✓ Visto');
    else if (inCorso(v)) stato.push(`Arrivato a ${minutiSecondi(posizioneDi(v).pos)}`);
  } else {
    const e = prossimoEpisodio(voce);
    const visti = voce.episodi.filter((x) => vistoVideo(x.video)).length;
    if (visti === voce.episodi.length) stato.push('✓ Vista tutta');
    else if (e && (visti || inCorso(e.video))) stato.push(`Prossimo: ${etichettaEpisodio(e)}${e.nome ? ' ' + e.nome : ''}`);
  }
  $('#vetrina-stato').textContent = stato.join(' · ');

  const sfondo = $('#vetrina-sfondo');
  const url = urlSfondo(info);
  if (url && sfondo.getAttribute('src') !== url) {
    sfondo.hidden = true;
    sfondo.onload = () => { sfondo.hidden = false; };
    sfondo.src = url;
  } else if (!url) {
    sfondo.hidden = true;
    sfondo.removeAttribute('src');
  }
}

// ---------- Griglia e righe ----------

function confronta(a, b) {
  if (ordine === 'titolo') return titoloDi(a).localeCompare(titoloDi(b), 'it');
  if (ordine === 'anno') return (annoDi(b) || 0) - (annoDi(a) || 0) || titoloDi(a).localeCompare(titoloDi(b), 'it');
  return b.data - a.data;
}

function filtroRicerca() {
  return chiaveDi($('#cerca').value || '');
}

function vociVisibili() {
  const f = filtroRicerca();
  return libreria.voci
    .filter((v) => !f || chiaveDi(titoloDi(v) + ' ' + v.titolo).includes(f))
    .sort(confronta);
}

// Film iniziati e serie con un episodio da riprendere, dal più recente
function vociInCorso() {
  const ultima = (voce) => {
    const lista = voce.tipo === 'film' ? [voce.video] : voce.episodi.map((e) => e.video);
    return Math.max(0, ...lista.map((v) => posizioneDi(v).agg || 0));
  };
  return libreria.voci.filter((voce) => {
    if (voce.tipo === 'film') return inCorso(voce.video);
    const e = prossimoEpisodio(voce);
    return e && e !== voce.episodi[0] || (e && inCorso(e.video));
  }).sort((a, b) => ultima(b) - ultima(a)).slice(0, 12);
}

function disegna(chiaveFocus, contestoFocus) {
  const attivo = document.activeElement;
  const chiave = chiaveFocus || (attivo && attivo.dataset && attivo.dataset.chiave);
  const contesto = contestoFocus || (attivo && attivo.dataset && attivo.dataset.contesto);

  $('#btn-ordina').textContent = 'Ordina: ' + ORDINAMENTI.find((o) => o.id === ordine).nome;

  const continua = filtroRicerca() ? [] : vociInCorso();
  $('#sezione-continua').hidden = !continua.length || !!serieAperta;
  const riga = $('#riga-continua');
  riga.innerHTML = '';
  continua.forEach((v) => riga.appendChild(creaLocandina(v, 'continua')));

  const griglia = $('#griglia');
  griglia.innerHTML = '';
  const voci = vociVisibili();
  voci.forEach((v) => griglia.appendChild(creaLocandina(v, 'tutti')));
  $('#sezione-tutti').hidden = !!serieAperta;
  $('#titolo-tutti').textContent = filtroRicerca() ? `Risultati (${voci.length})` : `Tutti (${voci.length})`;
  $('#messaggio').textContent = voci.length ? '' : (filtroRicerca() ? 'Nessun titolo trovato' : $('#messaggio').textContent);

  if (serieAperta) disegnaEpisodi(serieAperta);

  const bersaglio = chiave && document.querySelector(`.locandina[data-chiave="${CSS.escape(chiave)}"][data-contesto="${contesto}"]`);
  if (bersaglio) focalizza(bersaglio);
  else if (!document.activeElement || document.activeElement === document.body || !document.contains(attivo)) {
    focalizza(document.querySelector('#contenuto .locandina, #contenuto .episodio') || $('#cerca'));
  }
}

// ---------- Episodi di una serie ----------

function apriSerie(voce) {
  serieAperta = voce;
  $('#sezione-continua').hidden = true;
  $('#sezione-tutti').hidden = true;
  disegnaEpisodi(voce);
  const e = prossimoEpisodio(voce) || voce.episodi[0];
  focalizza(document.querySelector(`.episodio[data-url="${CSS.escape(e.video.url)}"]`) || document.querySelector('.episodio'));
}

function chiudiSerie() {
  const chiave = serieAperta.chiave;
  serieAperta = null;
  $('#sezione-episodi').hidden = true;
  disegna(chiave, 'tutti');
}

function disegnaEpisodi(voce) {
  $('#sezione-episodi').hidden = false;
  $('#titolo-episodi').textContent = titoloDi(voce) + ' · ◀ Indietro per tornare';
  const box = $('#episodi');
  const attivo = document.activeElement;
  const urlFocus = attivo && attivo.dataset && attivo.dataset.url;
  box.innerHTML = '';
  let stagione = null;
  voce.episodi.forEach((e, i) => {
    if (!voce.raccolta && e.stagione !== stagione) {
      stagione = e.stagione;
      const t = document.createElement('div');
      t.className = 'stagione';
      t.textContent = `Stagione ${stagione}`;
      box.appendChild(t);
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'focusable episodio' + (vistoVideo(e.video) ? ' visto-ep' : '');
    b.dataset.url = e.video.url;
    const frazione = avanzamento(e.video);
    b.innerHTML = '<span class="ep-num"></span><span class="ep-nome"></span><span class="ep-durata"></span>' +
      (frazione > 0 && frazione < 1 ? `<span class="avanzamento"><i style="width:${Math.round(frazione * 100)}%"></i></span>` : '');
    b.querySelector('.ep-num').textContent = vistoVideo(e.video) ? '✓' : etichettaEpisodio(e);
    b.querySelector('.ep-nome').textContent = e.nome || leggiFilm(e.video.titolo).titolo;
    b.querySelector('.ep-durata').textContent = durataBreve(e.video.durata);
    b.addEventListener('click', () => avviaEpisodio(voce, i));
    b.addEventListener('focus', () => alFocus(b));
    box.appendChild(b);
  });
  if (urlFocus) {
    const di = box.querySelector(`.episodio[data-url="${CSS.escape(urlFocus)}"]`);
    if (di) focalizza(di);
  }
}

// ---------- Riproduzione ----------

async function chiediRipresa(video, titolo) {
  if (!inCorso(video)) return 0;
  const pos = posizioneDi(video).pos;
  const v = await scegli(titolo, [
    { etichetta: `Riprendi da ${minutiSecondi(pos)}`, valore: 'riprendi' },
    { etichetta: "Dall'inizio", valore: 'inizio' },
    { etichetta: 'Annulla', valore: null },
  ]);
  if (v === null) return null;
  return v === 'riprendi' ? pos : 0;
}

async function scegliVoce(voce, contesto) {
  if (voce.tipo === 'serie') {
    if (contesto === 'continua') {
      const e = prossimoEpisodio(voce);
      if (e) { avviaEpisodio(voce, voce.episodi.indexOf(e)); return; }
    }
    apriSerie(voce);
    return;
  }
  const da = await chiediRipresa(voce.video, titoloDi(voce));
  if (da === null) return;
  riproduci([voce.video], 0, da, titoloDi(voce));
}

async function avviaEpisodio(voce, indice) {
  const e = voce.episodi[indice];
  const da = await chiediRipresa(e.video, `${titoloDi(voce)} · ${etichettaEpisodio(e)}`);
  if (da === null) return;
  // Playlist dall'episodio scelto in poi: alla fine il Media Player passa al successivo
  riproduci(voce.episodi.map((x) => x.video), indice, da, titoloDi(voce));
}

async function riproduci(lista, indice, daSecondi, titolo) {
  if (!IS_WEBOS) { toast(`Riproduzione di ${titolo}${daSecondi ? ' da ' + minutiSecondi(daSecondi) : ''} (simulata)`); return; }
  const v = lista[indice];
  const payload = lista.map((x) => ({
    mediaType: 'VIDEO',
    deviceType: 'dlna',
    udn: (libreria.server && libreria.server.udn) || '',
    fileName: x.titolo,
    fullPath: x.url,
    thumbnail: '',
    size: x.dimensione || 0,
    duration: x.durata || 0,
    dlna: { protocolInfo: x.protocolInfo, contentLength: x.dimensione || 0, duration: x.durata || 0, opVal: 1, flagVal: 0, cleartextSize: 0 },
  }));
  toast('Apertura di ' + titolo + '…');
  try {
    // Già aperto, il Media Player ignorerebbe la nuova playlist: va chiuso prima
    try {
      await lunaConFallback('luna://com.webos.applicationManager/closeByAppId', { id: MEDIA_PLAYER });
      await new Promise((r) => setTimeout(r, 1500));
    } catch (e) { /* non era aperto */ }
    await lunaConFallback('luna://com.webos.applicationManager/launch', { id: MEDIA_PLAYER, params: { payload, playIndex: indice } });
    // Il tracciatore salva la posizione e porta il video al punto scelto: anche 0 ("Dall'inizio"),
    // perché il Media Player ripartirebbe da solo da dove ci si era fermati
    await sh(`cd ${shQuote(cartellaApp())} && (setsid python3 traccia.py ${shQuote(v.url)} ${Math.floor(daSecondi || 0)} </dev/null >/dev/null 2>&1 &)`);
  } catch (e) {
    toast('Impossibile aprire il video: ' + e.message);
  }
}

// ---------- Menu (OK tenuto premuto) ----------

async function menuVoce(el) {
  if (el.classList.contains('episodio')) {
    const e = serieAperta.episodi.find((x) => x.video.url === el.dataset.url);
    const visto = vistoVideo(e.video);
    const scelta = await scegli(`${titoloDi(serieAperta)} · ${etichettaEpisodio(e)}`, [
      { etichetta: visto ? 'Segna come da vedere' : 'Segna come visto', valore: 'visto' },
      { etichetta: 'Segna visti tutti i precedenti', valore: 'precedenti' },
      { etichetta: 'Annulla', valore: null },
    ]);
    if (scelta === 'visto') await impostaVisto([e.video], !visto);
    if (scelta === 'precedenti') await impostaVisto(serieAperta.episodi.slice(0, serieAperta.episodi.indexOf(e) + 1).map((x) => x.video), true);
    if (scelta) disegnaEpisodi(serieAperta);
    return;
  }
  const voce = libreria.voci.find((v) => v.chiave === el.dataset.chiave);
  if (!voce) return;
  const video = voce.tipo === 'film' ? [voce.video] : voce.episodi.map((e) => e.video);
  const visto = vistoVoce(voce);
  const opzioni = [{ etichetta: visto ? 'Segna come da vedere' : (voce.tipo === 'film' ? 'Segna come visto' : 'Segna tutta come vista'), valore: 'visto' }];
  if (el.dataset.contesto === 'continua') opzioni.push({ etichetta: 'Togli da Continua a guardare', valore: 'togli' });
  opzioni.push({ etichetta: 'Annulla', valore: null });
  const scelta = await scegli(titoloDi(voce), opzioni);
  if (scelta === 'visto') await impostaVisto(video, !visto);
  if (scelta === 'togli') {
    video.forEach((v) => { if (posizioni[v.url]) posizioni[v.url].pos = 0; });
    if (voce.tipo === 'serie') {
      // Senza episodi iniziati la serie esce dalla riga solo se si riparte dal primo: si azzerano i "visto"
      const e = prossimoEpisodio(voce);
      if (e && e !== voce.episodi[0]) await impostaVisto(video, false);
      else await scriviPosizioni();
    } else {
      await scriviPosizioni();
    }
  }
  if (scelta) disegna(voce.chiave, scelta === 'togli' ? 'tutti' : el.dataset.contesto);
}

// Vetrina aggiornata a ogni spostamento del focus (frecce o puntatore)
function alFocus(el) {
  if (el.classList.contains('locandina')) {
    const voce = libreria.voci.find((v) => v.chiave === el.dataset.chiave);
    if (voce) mostraVetrina(voce, el.dataset.contesto);
  } else if (el.classList.contains('episodio') && serieAperta) {
    const e = serieAperta.episodi.find((x) => x.video.url === el.dataset.url);
    if (e) mostraVetrina(serieAperta, 'episodi', e);
  }
}

// ---------- Caricamento ----------

async function caricaConfig() {
  if (!IS_WEBOS) return;
  try {
    config = jsonSicuro(await sh(`cat ${shQuote(cartellaDashboard() + '/config.json')} 2>/dev/null`)) || {};
  } catch (e) { config = {}; }
}

async function caricaLibreria() {
  $('#messaggio').textContent = 'Lettura della libreria…';
  try {
    const indice = await leggiIndice();
    libreria = { server: indice.server, voci: raggruppa(indice.video || []) };
    $('#messaggio').textContent = libreria.voci.length ? '' : 'Nessun video sul server DLNA';
  } catch (e) {
    $('#messaggio').textContent = 'Server DLNA non disponibile: ' + e.message;
  }
  await leggiPosizioni();
  disegna();
  // Locandine e trame arrivano una alla volta; si ridisegna senza perdere la selezione
  let attesa = null;
  arricchisci(libreria.voci, () => {
    clearTimeout(attesa);
    attesa = setTimeout(() => {
      disegna();
      const a = document.activeElement;
      if (a && a.dataset && a.dataset.chiave) {
        const voce = libreria.voci.find((v) => v.chiave === a.dataset.chiave);
        if (voce) mostraVetrina(voce, a.dataset.contesto);
      }
    }, 400);
  });
}

// ---------- Tasti ----------

let timerPressione = null;
let attendiRilascioOk = false;

function indietro() {
  if (!$('#scelta').hidden) { chiudiScelta(null); return; }
  if (serieAperta) { chiudiSerie(); return; }
  if ($('#cerca').value) {
    $('#cerca').value = '';
    disegna();
    return;
  }
  esci();
}

// Uscendo si torna alla dashboard (e non alla Home LG)
async function esci() {
  if (!IS_WEBOS) return;
  try {
    await lunaConFallback('luna://com.webos.applicationManager/launch', { id: DASHBOARD_ID });
  } catch (e) {
    window.close();
  }
}

document.addEventListener('keydown', (e) => {
  const attivo = document.activeElement;
  const inInput = attivo && attivo.tagName === 'INPUT';
  if (e.keyCode === KEY.ENTER && attendiRilascioOk) { e.preventDefault(); return; }
  attendiRilascioOk = false;

  switch (e.keyCode) {
    case KEY.LEFT: if (!inInput) { muovi('sinistra'); e.preventDefault(); } break;
    case KEY.RIGHT: if (!inInput) { muovi('destra'); e.preventDefault(); } break;
    case KEY.UP: muovi('su'); e.preventDefault(); break;
    case KEY.DOWN: muovi('giu'); e.preventDefault(); break;
    case KEY.ENTER:
      if (attivo && (attivo.classList.contains('locandina') || attivo.classList.contains('episodio'))) {
        e.preventDefault();
        if (!e.repeat && !timerPressione) {
          timerPressione = setTimeout(() => {
            timerPressione = null;
            attendiRilascioOk = true;
            menuVoce(attivo);
          }, DURATA_PRESSIONE_LUNGA);
        }
      }
      break;
    case KEY.BACK:
    case KEY.ESC:
      e.preventDefault();
      if (inInput) { attivo.blur(); focalizza($('#cerca')); return; }
      indietro();
      break;
    default:
  }
});

document.addEventListener('keyup', (e) => {
  if (e.keyCode !== KEY.ENTER) return;
  if (attendiRilascioOk) { attendiRilascioOk = false; return; }
  if (timerPressione) {
    clearTimeout(timerPressione);
    timerPressione = null;
    if (document.activeElement) document.activeElement.click();
  }
});

// Rotella del Magic Remote: scorre l'area dei titoli
document.addEventListener('wheel', (e) => {
  if (!$('#scelta').hidden) return;
  e.preventDefault();
  $('#contenuto').scrollTop += e.deltaY > 0 ? 160 : -160;
}, { passive: false });

document.addEventListener('mouseover', (e) => {
  const el = e.target.closest && e.target.closest('.focusable');
  if (el && el.tagName !== 'INPUT' && elementiNavigabili().includes(el)) el.focus({ preventScroll: true });
});

$('#cerca').addEventListener('input', () => {
  if (serieAperta) { serieAperta = null; $('#sezione-episodi').hidden = true; }
  disegna(null, null);
  $('#cerca').focus({ preventScroll: true });
});
$('#btn-ordina').addEventListener('click', () => {
  const i = ORDINAMENTI.findIndex((o) => o.id === ordine);
  ordine = ORDINAMENTI[(i + 1) % ORDINAMENTI.length].id;
  try { localStorage.setItem(STORAGE_ORDINE, ordine); } catch (e) { /* solo per questa volta */ }
  disegna(null, null);
  $('#btn-ordina').focus({ preventScroll: true });
});
$('#btn-aggiorna').addEventListener('click', () => {
  caricaLibreria();
  toast('Aggiornamento della libreria…');
});

// Tornando dal Media Player: posizioni nuove (Continua a guardare, visto)
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return;
  await leggiPosizioni();
  if (serieAperta) { disegnaEpisodi(serieAperta); return; }
  // Si riparte da quello che si stava guardando, primo in "Continua a guardare"
  const primo = !filtroRicerca() && vociInCorso()[0];
  if (primo) disegna(primo.chiave, 'continua');
  else disegna();
});
document.addEventListener('webOSRelaunch', async () => {
  await leggiPosizioni();
  disegna();
});

(async function avvia() {
  adattaScala();
  await caricaConfig();
  await caricaLibreria();
}());
