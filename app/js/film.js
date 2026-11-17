'use strict';

// Card "Film": i video di un server DLNA della rete (letti da dlna.py come root), aperti nel Media Player LG.
// config.json → dlna: { url: "http://IP:PORTA" } facoltativo; senza, il server viene cercato in rete.

const INTERVALLO_FILM = 30 * 60 * 1000;
const MEDIA_PLAYER = 'com.webos.app.mediadiscovery';

const FILM_DEMO = {
  server: { nome: 'Film', udn: '' },
  id: '0',
  titolo: 'Film',
  voci: [
    { tipo: 'cartella', id: 'demo-serie', titolo: 'Serie di esempio', figli: 3 },
    { tipo: 'video', id: 'd1', titolo: 'Il.Viaggio.2019.ITA.BRRip.720p.x264.mkv', durata: 5400, dimensione: 900000000, url: '' },
    { tipo: 'video', id: 'd2', titolo: 'La.Casa.Sul.Lago.2023.WEB-DL.1080p.mkv', durata: 6000, dimensione: 4000000000, url: '' },
    { tipo: 'video', id: 'd3', titolo: 'Un-corto-di-esempio.mp4', durata: 1500, dimensione: 200000000, url: '' },
    { tipo: 'video', id: 'd4', titolo: 'Una.Sera.D.Estate.2024.FULL.HD.1080p.mkv', durata: 5700, dimensione: 15000000000, url: '' },
  ],
};

// Cartelle aperte, dalla prima: [{ id, titolo, voci, server }]
let pilaFilm = [];

// "Red.E.Toby.Nemiciamici.1981.ITA-ENG.BDRip.720p.mkv" → "Red E Toby Nemiciamici (1981)"
function titoloFilm(nome) {
  let t = String(nome || '').replace(/\.(mkv|mp4|m4v|avi|mov|ts|m2ts|wmv|webm|mpe?g)$/i, '');
  t = t.replace(/[._]+/g, ' ').replace(/(\p{L})-(?=\p{L})/gu, '$1 ');
  const anno = t.match(/^(.+?)\s*[([]?\b((?:19|20)\d\d)\b[)\]]?(?:\s|$)/);
  if (anno && anno[1].trim().length > 1) return `${anno[1].trim()} (${anno[2]})`;
  t = t.replace(/\s*\b(2160p|1080p|720p|480p|4k|uhd|hdr|web[ -]?dl|webrip|bdrip|brrip|bluray|x26[45]|h ?26[45]|hevc|ac3|dts\S*|aac|ita|eng|sub\S*|full hd)\b.*$/i, '');
  return t.replace(/\s{2,}/g, ' ').trim() || nome;
}

function durataBreve(s) {
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${pad(m)}` : `${m} min`;
}

function dimensioneBreve(b) {
  if (!b) return '';
  return b >= 1e9 ? (b / 1e9).toFixed(1).replace('.', ',') + ' GB' : Math.round(b / 1e6) + ' MB';
}

async function sfogliaDlna(id) {
  if (!IS_WEBOS) {
    if (id === 'demo-serie') {
      return { server: FILM_DEMO.server, id, voci: [1, 2, 3].map((n) => ({ tipo: 'video', id: 'e' + n, titolo: `Serie di esempio_S01E0${n}.mkv`, durata: 3200, url: '' })) };
    }
    return FILM_DEMO;
  }
  const url = (config.dlna && config.dlna.url) || '';
  const out = await sh(`python3 ${shQuote(cartellaApp() + '/dlna.py')} sfoglia ${shQuote(id || '')} ${shQuote(url)}`);
  const r = jsonSicuro(out.trim());
  if (!r) throw new Error('risposta non valida');
  if (r.errore) throw new Error(r.errore);
  return r;
}

async function aggiornaFilm() {
  const stato = $('#film-stato');
  // Dentro una sottocartella non si torna in cima da soli: si aggiorna solo la radice
  if (pilaFilm.length > 1) return;
  try {
    const r = await sfogliaDlna('');
    pilaFilm = [{ id: r.id, titolo: r.titolo, voci: r.voci, server: r.server }];
    $('#film-server').textContent = r.server.nome;
    stato.textContent = '';
    disegnaFilm();
  } catch (e) {
    stato.textContent = '';
    if (!pilaFilm.length) $('#film-lista').innerHTML = `<li class="messaggio">Server DLNA non disponibile: ${e.message}</li>`;
  }
}

async function apriCartellaFilm(voce) {
  $('#film-stato').textContent = 'Apertura…';
  try {
    const r = await sfogliaDlna(voce.id);
    pilaFilm.push({ id: voce.id, titolo: titoloFilm(voce.titolo), voci: r.voci, server: r.server });
    disegnaFilm(true);
  } catch (e) {
    toast('Impossibile aprire la cartella: ' + e.message);
  }
  $('#film-stato').textContent = '';
}

function cartellaSuFilm() {
  if (pilaFilm.length < 2) return false;
  const lasciata = pilaFilm.pop();
  disegnaFilm(true, lasciata.id);
  return true;
}

// Una riga per voce; dentro una cartella la prima riga riporta su
function disegnaFilm(daFocalizzare, idFocus) {
  const lista = $('#film-lista');
  const cartella = pilaFilm[pilaFilm.length - 1];
  if (!cartella) return;
  const attivo = document.activeElement;
  const chiave = idFocus || (lista.contains(attivo) && attivo.dataset.film);
  lista.innerHTML = '';
  $('#film-percorso').textContent = pilaFilm.length > 1 ? cartella.titolo : '';

  const riga = (classe, id, titolo, dettaglio, azione) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'focusable voce-film ' + classe;
    b.dataset.film = id;
    const t = document.createElement('span');
    t.className = 'film-titolo';
    t.textContent = titolo;
    const d = document.createElement('span');
    d.className = 'film-dettaglio';
    d.textContent = dettaglio;
    b.append(t, d);
    b.addEventListener('click', azione);
    li.appendChild(b);
    lista.appendChild(li);
  };

  if (pilaFilm.length > 1) riga('su', '..', '◀ Indietro', pilaFilm[pilaFilm.length - 2].titolo, cartellaSuFilm);
  if (!cartella.voci.length) {
    const li = document.createElement('li');
    li.className = 'messaggio';
    li.textContent = 'Cartella vuota';
    lista.appendChild(li);
  }
  const video = cartella.voci.filter((v) => v.tipo === 'video');
  cartella.voci.forEach((v) => {
    if (v.tipo === 'cartella') {
      riga('cartella', v.id, titoloFilm(v.titolo), v.figli ? (v.figli === 1 ? '1 elemento' : `${v.figli} elementi`) : 'Cartella', () => apriCartellaFilm(v));
    } else {
      riga('video', v.id, titoloFilm(v.titolo), [durataBreve(v.durata), dimensioneBreve(v.dimensione)].filter(Boolean).join(' · '),
        () => apriFilm(video, video.indexOf(v), cartella.server));
    }
  });

  const bersaglio = (chiave && lista.querySelector(`[data-film="${CSS.escape(chiave)}"]`)) ||
    (daFocalizzare && lista.querySelector('.voce-film'));
  if (bersaglio && (daFocalizzare || lista.contains(document.activeElement) || attivo === document.body)) focalizza(bersaglio);
  aggiornaSfumaturaFilm();
}

function aggiornaSfumaturaFilm() {
  const lista = $('#film-lista');
  lista.classList.toggle('altro-sotto', lista.scrollTop + lista.clientHeight < lista.scrollHeight - 4);
}
$('#film-lista').addEventListener('scroll', aggiornaSfumaturaFilm);

// Il Media Player LG accetta una playlist nei parametri di avvio (stessa via dei link "riproduci" di LG):
// così funzionano riprendi, tracce audio, sottotitoli e l'episodio successivo
async function apriFilm(video, indice, server) {
  const v = video[indice];
  if (!IS_WEBOS) { toast('Apertura di ' + titoloFilm(v.titolo) + ' (simulato)'); return; }
  const payload = video.map((x) => ({
    mediaType: 'VIDEO',
    deviceType: 'dlna',
    udn: (server && server.udn) || '',
    fileName: x.titolo,
    fullPath: x.url,
    thumbnail: x.miniatura || '',
    size: x.dimensione || 0,
    duration: x.durata || 0,
    dlna: { protocolInfo: x.protocolInfo, contentLength: x.dimensione || 0, duration: x.durata || 0, opVal: 1, flagVal: 0, cleartextSize: 0 },
  }));
  try {
    // Se il Media Player è già aperto in background, rilanciato ignora la playlist e riprende il suo video:
    // va chiuso e riaperto da zero
    try {
      await lunaConFallback('luna://com.webos.applicationManager/closeByAppId', { id: MEDIA_PLAYER });
      await new Promise((r) => setTimeout(r, 1500));
    } catch (e) { /* non era aperto */ }
    await lunaConFallback('luna://com.webos.applicationManager/launch', { id: MEDIA_PLAYER, params: { payload, playIndex: indice } });
  } catch (e) {
    toast('Impossibile aprire il film: ' + e.message);
  }
}
