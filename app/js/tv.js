'use strict';

// Card "In onda": canale attuale, programma in corso e successivo, canali preferiti.
// I servizi TV di LG cambiano tra versioni: si provano più nomi e si tiene quello che risponde.

const INTERVALLO_TV = 60 * 1000;
const FILE_CANALE = '/var/lib/webosbrew/dashboard/canale.json';

// Su webOS 11 (G6 2026) i servizi TV passano da com.webos.service.apiadapter (servizi presenti secondo diagnostica.sh)
const EP_CANALE = [
  { uri: 'luna://com.webos.service.apiadapter/tv/getCurrentChannel' },
  { uri: 'luna://com.webos.service.tv.channel/getCurrentChannel' },
  { uri: 'luna://com.webos.service.tvbroadcast/getCurrentChannel' },
  { uri: 'luna://com.webos.service.tv.broadcast/getCurrentChannel' },
];
const EP_PROGRAMMI = [
  { uri: 'luna://com.webos.service.apiadapter/tv/getChannelProgramInfo', params: (id) => ({ channelId: id }) },
  { uri: 'luna://com.webos.service.apiadapter/tv/getChannelCurrentProgramInfo', params: () => ({}) },
  { uri: 'luna://com.webos.service.tv.channel/getChannelProgramInfo', params: (id) => ({ channelId: id }) },
  { uri: 'luna://com.webos.service.tv.epg/getChannelProgramInfo', params: (id) => ({ channelId: id }) },
];
const EP_APRI_CANALE = [
  { uri: 'luna://com.webos.service.apiadapter/tv/openChannel', params: (n) => ({ channelNumber: n }) },
  { uri: 'luna://com.webos.service.tv.channel/openChannel', params: (n) => ({ channelNumber: n }) },
  { uri: 'luna://com.webos.applicationManager/launch', params: (n) => ({ id: 'com.webos.app.livetv', params: { channelNumber: n } }) },
];

const TV_DEMO = {
  canale: { channelNumber: '5', channelName: 'Canale 5', channelId: 'demo' },
  programmi: (() => {
    const ora = new Date();
    const inizio = new Date(ora.getFullYear(), ora.getMonth(), ora.getDate(), ora.getHours(), 0);
    const fine = new Date(inizio.getTime() + 90 * 60000);
    const dopo = new Date(fine.getTime() + 60 * 60000);
    return [
      { programName: 'Film della sera', inizio, fine },
      { programName: 'Notiziario', inizio: fine, fine: dopo },
    ];
  })(),
};

// "2026,11,04,20,30,00" oppure "2026/11/04 20:30:00": ora locale
function leggiOrario(testo) {
  if (!testo) return null;
  const n = String(testo).split(/\D+/).filter(Boolean).map(Number);
  if (n.length < 5) return null;
  return new Date(n[0], n[1] - 1, n[2], n[3], n[4], n[5] || 0);
}

// Guida dal database EPG della TV (com.webos.epgdb). Su webOS 11.2 apiadapter/getChannelProgramInfo
// restituisce il palinsesto del giorno dopo; il database ha quello giusto. Si cerca per signalChannelId
// (TSID_SVCID_ONID, le ultime tre parti del channelId) a partire da 6 ore fa.
const KIND_PALINSESTO = 'com.webos.programSCH:4';
const KIND_IN_CORSO = 'com.webos.programPF:4';

const orarioEpg = (d) => [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate()),
  pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds())].join(',');

async function programmiDaEpgdb(canale) {
  const segnale = canale.signalChannelId || String(canale.channelId || '').split('_').slice(-3).join('_');
  if (!segnale) return [];
  const cerca = (from, where) => lunaConFallback('luna://com.webos.epgdb/find', { query: { from, where, limit: 30 } })
    .then((r) => r.results || []).catch(() => []);
  let lista = await cerca(KIND_PALINSESTO, [
    { prop: 'signalChannelId', op: '=', val: segnale },
    { prop: 'localStartTime', op: '>=', val: orarioEpg(new Date(Date.now() - 6 * 3600 * 1000)) },
  ]);
  if (!lista.length) lista = await cerca(KIND_IN_CORSO, [{ prop: 'signalChannelId', op: '=', val: segnale }]);
  return normalizzaProgrammi({ programList: lista });
}

function normalizzaProgrammi(r) {
  const lista = r.programList || r.programs || (r.program ? [r.program] : (r.programName ? [r] : []));
  return lista.map((p) => ({
    programName: p.programName || p.title || '',
    inizio: leggiOrario(p.localStartTime || p.startTime),
    fine: leggiOrario(p.localEndTime || p.endTime),
  })).filter((p) => p.programName && p.inizio && p.fine).sort((a, b) => a.inizio - b.inizio);
}

async function aggiornaTv() {
  const stato = $('#tv-stato');
  let canale;
  let programmi = [];
  if (!IS_WEBOS) {
    canale = TV_DEMO.canale;
    programmi = TV_DEMO.programmi;
    stato.textContent = 'dati demo';
  } else {
    let ultimoVisto = false;
    try {
      const r = await lunaCandidati('canale', EP_CANALE);
      canale = r.channel || r;
    } catch (e) {
      // Con la dashboard in primo piano Live TV non trasmette: si usa l'ultimo canale salvato dal servizio
      canale = jsonSicuro(await sh(`cat ${FILE_CANALE} 2>/dev/null`).catch(() => ''));
      ultimoVisto = true;
    }
    if (!canale || !(canale.channelId || canale.channelName)) {
      $('#tv-corrente').innerHTML = '<div class="messaggio">Nessun canale ancora. Guarda un canale con Live TV ' +
        'e la dashboard mostrerà qui l\'ultimo visto con la guida programmi.</div>';
      stato.textContent = '';
      disegnaPreferiti();
      return;
    }
    try {
      programmi = await programmiDaEpgdb(canale);
      if (!programmi.length) {
        programmi = normalizzaProgrammi(await lunaCandidati('programmi', EP_PROGRAMMI, canale.channelId));
      }
    } catch (e) { /* solo il canale */ }
    stato.textContent = ultimoVisto ? 'ultimo canale visto' : '';
  }
  disegnaTv(canale, programmi);
  disegnaPreferiti();
}

// "17:35" se è oggi, "domani 17:35", altrimenti "sab 17:35": la guida può avere solo i giorni successivi
const GIORNI_BREVI = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
function quandoProgramma(d) {
  const oggi = new Date();
  const giorni = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) -
    new Date(oggi.getFullYear(), oggi.getMonth(), oggi.getDate())) / 86400000);
  if (giorni === 0) return oraMinuti(d);
  if (giorni === 1) return 'domani ' + oraMinuti(d);
  return GIORNI_BREVI[d.getDay()] + ' ' + oraMinuti(d);
}

function disegnaTv(canale, programmi) {
  const adesso = new Date();
  const inCorso = programmi.find((p) => p.inizio <= adesso && p.fine > adesso);
  const successivo = programmi.find((p) => p.inizio >= (inCorso ? inCorso.fine : adesso));
  const nome = canale.channelName || canale.name || 'Canale';
  const numero = canale.channelNumber || canale.number || '';

  let html = `<div class="tv-canale">${numero ? `<span class="numero">${numero}</span>` : ''}${escapeHtml(nome)}</div>`;
  if (inCorso) {
    const durata = inCorso.fine - inCorso.inizio;
    const avanzamento = Math.max(0, Math.min(1, (adesso - inCorso.inizio) / durata));
    html += `<div class="tv-programma">${escapeHtml(inCorso.programName)}</div>
      <div class="tv-orario">${oraMinuti(inCorso.inizio)} – ${oraMinuti(inCorso.fine)}</div>
      <div class="barra"><i style="width:${(avanzamento * 100).toFixed(1)}%"></i></div>`;
  } else {
    html += `<div class="tv-orario">${programmi.length ? 'Programma in corso non presente nella guida'
      : 'Guida programmi non disponibile'}</div>`;
  }
  if (successivo) {
    const quando = quandoProgramma(successivo.inizio);
    const etichetta = quando.includes(' ') ? maiuscola(quando.replace(' ', ' alle ')) : 'Dopo, alle ' + quando;
    html += `<div class="tv-dopo">${etichetta}: <b>${escapeHtml(successivo.programName)}</b></div>`;
    // Il resto della serata, per riempire la card
    const piuTardi = programmi.filter((p) => p.inizio > successivo.inizio).slice(0, 3);
    if (piuTardi.length) {
      html += '<ul class="tv-palinsesto">' + piuTardi.map((p) =>
        `<li><span class="quando">${quandoProgramma(p.inizio)}</span>${escapeHtml(p.programName)}</li>`).join('') + '</ul>';
    }
  }
  $('#tv-corrente').innerHTML = html;
}

function disegnaPreferiti() {
  const box = $('#tv-preferiti');
  if (box.childElementCount) return;
  const preferiti = Array.isArray(config.canaliPreferiti) ? config.canaliPreferiti
    : (IS_WEBOS ? [] : [{ numero: '1', nome: 'Rai 1' }, { numero: '5', nome: 'Canale 5' }, { numero: '7', nome: 'La7' }]);
  preferiti.forEach((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'focusable chip';
    b.innerHTML = `<span class="numero">${escapeHtml(String(c.numero))}</span>${escapeHtml(c.nome || '')}`;
    b.addEventListener('click', () => apriCanale(String(c.numero), c.nome));
    box.appendChild(b);
  });
}

async function apriCanale(numero, nome) {
  if (!IS_WEBOS) { toast(`Canale ${numero} ${nome || ''} (simulato)`); return; }
  try {
    await lunaCandidati('apriCanale', EP_APRI_CANALE, numero);
    setTimeout(aggiornaTv, 3000);
  } catch (e) {
    toast('Impossibile cambiare canale: ' + e.message);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// OK sul riquadro: torna a Live TV sull'ultimo canale
$('#tv-corrente').addEventListener('click', () => {
  if (!IS_WEBOS) { toast('Apertura di Live TV (simulata)'); return; }
  lunaConFallback('luna://com.webos.applicationManager/launch', { id: 'com.webos.app.livetv' })
    .catch((e) => toast('Impossibile aprire Live TV: ' + e.message));
});
