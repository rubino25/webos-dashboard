'use strict';

// Libreria: video del server DLNA (dlna.py indice), raggruppati in film e serie,
// con locandine e trame da TMDB e le posizioni salvate da traccia.py.

const FILE_POSIZIONI = '/var/lib/webosbrew/dashboard/film-posizioni.json';
const CACHE_TMDB = 'film.tmdb';
const DURATA_CACHE_TMDB = 14 * 24 * 3600 * 1000;
const DURATA_CACHE_MANCANTI = 2 * 24 * 3600 * 1000;
const IMG_TMDB = 'https://image.tmdb.org/t/p/';

let config = {};
let libreria = { server: null, voci: [] }; // voci: film e serie
let posizioni = {};                          // url → { pos, visto, agg, durata }

// ---------- Nomi dei file ----------

const QUALITA = /\s*\b(2160p|1080p|720p|480p|4k|uhd|hdr|web[ -]?dl|webrip|bdrip|brrip|bluray|x26[45]|h ?26[45]|hevc|ac3|dts\S*|aac|ita|eng|sub\S*|full hd)\b.*$/i;

function pulisci(nome) {
  return String(nome || '')
    .replace(/\.(mkv|mp4|m4v|avi|mov|ts|m2ts|wmv|webm|mpe?g)$/i, '')
    .replace(/꞉/g, ':') // i due punti "finti" che Windows mette nei nomi dei file
    .replace(/[._]+/g, ' ')
    .replace(/(\p{L})-(?=\p{L})/gu, '$1 ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// "Il.Viaggio.2019.ITA.BRRip.720p.mkv" → { titolo: "Il Viaggio", anno: 2019 }
function leggiFilm(nome) {
  const t = pulisci(nome);
  const anno = t.match(/^(.+?)\s*[([]?\b((?:19|20)\d\d)\b[)\]]?(?:\s|$)/);
  if (anno && anno[1].trim().length > 1) return { titolo: anno[1].trim(), anno: Number(anno[2]) };
  return { titolo: t.replace(QUALITA, '').trim() || t, anno: null };
}

// "Serie di esempio_S01E03_Terzo.mkv" → { serie: "Serie di esempio", stagione: 1, episodio: 3, nome: "Terzo" }
function leggiEpisodio(nome) {
  const t = pulisci(nome);
  const m = t.match(/^(.*?)[\s-]*\bS(\d{1,2})\s?E(\d{1,3})\b\s*-?\s*(.*)$/i);
  if (!m || !m[1].trim()) return null;
  return {
    serie: m[1].replace(/[\s:-]+$/, '').trim(),
    stagione: Number(m[2]),
    episodio: Number(m[3]),
    nome: m[4].replace(QUALITA, '').trim(),
  };
}

const chiaveDi = (s) => s.toLowerCase().normalize('NFD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const dataDi = (v) => Date.parse(v.data || '') || 0;

// ---------- Indice dal server DLNA ----------

const INDICE_DEMO = {
  server: { nome: 'Film', udn: '' },
  video: [
    ['Il.Viaggio.2019.ITA.BRRip.720p.x264-ABC.mkv', [], 5400, '2026-01-10'],
    ['La.Casa.Sul.Lago.2023.WEB-DL.1080p.mkv', [], 6000, '2026-05-10'],
    ['Un-corto-di-esempio.mp4', [], 1500, '2026-02-10'],
    ['Una.Sera.D.Estate.2024.FULL.HD.1080p.mkv', [], 5700, '2026-06-10'],
    ['Watch Esempio (1).mp4', [], 7000, '2026-04-10'],
    ['Serie di esempio_S01E01_Primo.mkv', ['Serie di esempio'], 3200, '2026-03-10'],
    ['Serie di esempio_S01E02_Secondo.mkv', ['Serie di esempio'], 2900, '2026-03-10'],
    ['Serie di esempio_S02E01_Terzo.mkv', ['Serie di esempio'], 2800, '2026-03-10'],
    ['Titolo Lungo꞉ Una storia di esempio S01E04 Episodio 4 1080p.mkv', ['x'], 3000, '2026-07-10'],
    ['Titolo Lungo꞉ Una storia di esempio S01E05 Episodio 5 1080p.mkv', ['y'], 3000, '2026-08-10'],
  ].map(([titolo, cartelle, durata, data], i) => ({ titolo, cartelle, durata, data, url: 'demo://' + i, dimensione: 1e9 })),
};

async function leggiIndice() {
  if (!IS_WEBOS) return INDICE_DEMO;
  const url = (config.dlna && config.dlna.url) || '';
  const out = await sh(`python3 ${shQuote(cartellaApp() + '/dlna.py')} indice ${shQuote(url)}`);
  const r = jsonSicuro(out.trim());
  if (!r) throw new Error('risposta non valida dal server DLNA');
  if (r.errore) throw new Error(r.errore);
  return r;
}

// Episodi (SxxEyy) raggruppati per serie; cartelle con più video senza numerazione diventano raccolte
function raggruppa(video) {
  const serie = new Map();
  const film = [];
  const perCartella = new Map();
  video.forEach((v) => {
    const ep = leggiEpisodio(v.titolo);
    if (ep) {
      const k = chiaveDi(ep.serie);
      if (!serie.has(k)) serie.set(k, { tipo: 'serie', chiave: 's:' + k, titolo: ep.serie, cartella: v.cartelle[0] || '', episodi: [] });
      serie.get(k).episodi.push(Object.assign({ video: v }, ep));
      return;
    }
    const cartella = v.cartelle.join(' / ');
    if (cartella) {
      if (!perCartella.has(cartella)) perCartella.set(cartella, []);
      perCartella.get(cartella).push(v);
    } else {
      film.push(v);
    }
  });
  // Una cartella con un solo video è solo un contenitore: conta come film
  perCartella.forEach((lista, cartella) => {
    if (lista.length === 1) { film.push(lista[0]); return; }
    serie.set('c:' + cartella, {
      tipo: 'serie', chiave: 'c:' + chiaveDi(cartella), titolo: cartella.split(' / ').pop(), cartella, raccolta: true,
      episodi: lista.map((v, i) => ({ video: v, stagione: 0, episodio: i + 1, nome: leggiFilm(v.titolo).titolo })),
    });
  });

  const voci = film.map((v) => {
    const f = leggiFilm(v.titolo);
    return { tipo: 'film', chiave: 'f:' + chiaveDi(f.titolo) + (f.anno || ''), titolo: f.titolo, anno: f.anno, video: v, data: dataDi(v) };
  });
  serie.forEach((s) => {
    s.episodi.sort((a, b) => a.stagione - b.stagione || a.episodio - b.episodio || a.video.titolo.localeCompare(b.video.titolo));
    s.data = Math.max(...s.episodi.map((e) => dataDi(e.video)));
    voci.push(s);
  });
  return voci;
}

// ---------- Posizioni (scritte da traccia.py, "visto" anche a mano) ----------

async function leggiPosizioni() {
  if (!IS_WEBOS) {
    posizioni = { 'demo://1': { pos: 2400, agg: Date.now() / 1000 }, 'demo://5': { visto: true, pos: 0, agg: 1 }, 'demo://6': { pos: 900, agg: Date.now() / 1000 - 100 } };
    return;
  }
  try {
    posizioni = jsonSicuro(await sh(`cat ${FILE_POSIZIONI} 2>/dev/null`)) || {};
  } catch (e) { /* restano quelle di prima */ }
}

async function scriviPosizioni() {
  if (!IS_WEBOS) return;
  const json = JSON.stringify(posizioni);
  await sh(`mkdir -p /var/lib/webosbrew/dashboard && printf '%s' ${shQuote(json)} > ${FILE_POSIZIONI}.tmp && mv ${FILE_POSIZIONI}.tmp ${FILE_POSIZIONI}`);
}

const posizioneDi = (v) => posizioni[v.url] || {};
const vistoVideo = (v) => !!posizioneDi(v).visto;

// In corso: iniziato da più di un minuto, non visto
function inCorso(v) {
  const p = posizioneDi(v);
  return !p.visto && p.pos > 60;
}

function avanzamento(v) {
  const p = posizioneDi(v);
  const durata = v.durata || p.durata || 0;
  if (p.visto) return 1;
  return durata && p.pos ? Math.min(1, p.pos / durata) : 0;
}

// Episodio da cui riprendere una serie: quello iniziato più di recente, altrimenti il primo non visto
function prossimoEpisodio(s) {
  const iniziati = s.episodi.filter((e) => inCorso(e.video))
    .sort((a, b) => (posizioneDi(b.video).agg || 0) - (posizioneDi(a.video).agg || 0));
  if (iniziati[0]) return iniziati[0];
  let ultimoVisto = -1;
  s.episodi.forEach((e, i) => { if (vistoVideo(e.video)) ultimoVisto = i; });
  return s.episodi[ultimoVisto + 1] || null;
}

function vistoVoce(voce) {
  return voce.tipo === 'film' ? vistoVideo(voce.video) : voce.episodi.every((e) => vistoVideo(e.video));
}

async function impostaVisto(videoLista, visto) {
  const adesso = Math.round(Date.now() / 1000);
  videoLista.forEach((v) => {
    posizioni[v.url] = Object.assign({}, posizioni[v.url], { visto, pos: 0, agg: adesso });
  });
  await scriviPosizioni();
}

// ---------- TMDB: locandine, sfondi, trame ----------

let cacheTmdb = {};
try { cacheTmdb = JSON.parse(localStorage.getItem(CACHE_TMDB) || '{}'); } catch (e) { cacheTmdb = {}; }

function salvaCacheTmdb() {
  try { localStorage.setItem(CACHE_TMDB, JSON.stringify(cacheTmdb)); } catch (e) { /* storage pieno */ }
}

function chiaveTmdb() {
  return (config.tmdb && (config.tmdb.apiKey || config.tmdb.token)) || '';
}

// Accetta sia la "chiave API" (v3) sia il "token di lettura" (v4, inizia con eyJ)
async function chiamaTmdb(percorso, parametri) {
  const chiave = chiaveTmdb();
  const q = new URLSearchParams(Object.assign({ language: 'it-IT', include_adult: 'false' }, parametri));
  const intestazioni = { accept: 'application/json' };
  if (/^eyJ/.test(chiave)) intestazioni.Authorization = 'Bearer ' + chiave;
  else q.set('api_key', chiave);
  return jsonSicuro(await fetchTesto(`https://api.themoviedb.org/3/${percorso}?${q}`, intestazioni)) || {};
}

async function cercaTmdb(voce) {
  const r = voce.tipo === 'film'
    ? await chiamaTmdb('search/movie', Object.assign({ query: voce.titolo }, voce.anno ? { year: voce.anno } : {}))
    : await chiamaTmdb('search/tv', { query: voce.titolo });
  let primo = (r.results || [])[0];
  if (!primo && voce.tipo === 'film' && voce.anno) primo = ((await chiamaTmdb('search/movie', { query: voce.titolo })).results || [])[0];
  if (!primo) return { nessuno: true };
  return {
    titolo: primo.title || primo.name,
    trama: primo.overview || '',
    locandina: primo.poster_path || '',
    sfondo: primo.backdrop_path || '',
    anno: Number(String(primo.release_date || primo.first_air_date || '').slice(0, 4)) || null,
    voto: primo.vote_average || 0,
  };
}

// Dati TMDB della voce (dalla cache, oppure scaricati); null se non disponibili
function infoTmdb(voce) {
  const c = cacheTmdb[voce.chiave];
  return c && !c.nessuno ? c : null;
}

async function arricchisci(voci, aggiornata) {
  if (!chiaveTmdb()) return;
  for (const voce of voci) {
    const c = cacheTmdb[voce.chiave];
    const scadenza = c && (c.nessuno ? DURATA_CACHE_MANCANTI : DURATA_CACHE_TMDB);
    if (c && Date.now() - c.t < scadenza) continue;
    try {
      cacheTmdb[voce.chiave] = Object.assign(await cercaTmdb(voce), { t: Date.now() });
      salvaCacheTmdb();
      aggiornata(voce);
    } catch (e) {
      if (/401/.test(e.message)) { toast('Chiave TMDB non valida: controlla config.json'); return; }
    }
  }
}

const urlLocandina = (info) => (info && info.locandina ? IMG_TMDB + 'w342' + info.locandina : '');
const urlSfondo = (info) => (info && info.sfondo ? IMG_TMDB + 'w1280' + info.sfondo : '');
