'use strict';

// Pagina 1, riga dei controlli rapidi: ingresso, modalità immagine, timer, spegnimento

let modoImmagine = IS_WEBOS ? null : 'filmMaker';
let fineTimer = 0; // secondi epoch della scadenza, 0 = nessun timer

const MODI_SCEGLIBILI = ['vivid', 'standard', 'eco', 'cinema', 'sports', 'game', 'filmMaker', 'expert1', 'expert2'];

const ICONE_CONTROLLI = {
  ingresso: '<path d="M3 5h18v11H3zm2 2v7h14V7zM9 18h6v2H9z"/><path d="M8 10h5V8l3 3-3 3v-2H8z"/>',
  immagine: '<path d="M3 5h18v14H3zm2 2v10h14V7zm2 8l3-4 2 3 2-2 3 3z"/>',
  timer: '<path d="M10 1h4v2h-4z"/><path d="M12 5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zm0 2a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zm-1 2v5.6l3.8 2.2 1-1.7-2.8-1.6V9z"/>',
  spegni: '<path d="M11 2h2v10h-2z"/><path d="M6.3 5.4l1.4 1.4a6.5 6.5 0 1 0 8.6 0l1.4-1.4a8.5 8.5 0 1 1-11.4 0z"/>',
  app: '<path d="M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z"/>',
  wol: '<path d="M2 3h20v14H2zm2 2v10h16V5zM8 19h8v2H8z"/><path d="M11 6h2v4.5h-2z"/><path d="M8.9 7.6l1.2 1.2a2.7 2.7 0 1 0 3.8 0l1.2-1.2a4.4 4.4 0 1 1-6.2 0z"/>',
  riavvia: '<path d="M12 4a8 8 0 1 0 7.7 10h-2.1A6 6 0 1 1 12 6c1.6 0 3.1.6 4.2 1.8L13 11h7V4l-2.4 2.4A8 8 0 0 0 12 4z"/>',
};

const CONTROLLI = [
  { id: 'ingresso', icona: 'ingresso', nome: 'Ingresso', azione: scegliIngresso },
  { id: 'immagine', icona: 'immagine', nome: 'Immagine', azione: scegliImmagine },
  { id: 'timer', icona: 'timer', nome: 'Timer', azione: scegliTimer },
  { id: 'spegni', icona: 'spegni', nome: 'Spegni TV', azione: spegniTv, classe: 'pericolo' },
  { id: 'app', icona: 'app', nome: 'Tutte le app', azione: () => apriTutteLeApp() },
  { id: 'wol', icona: 'wol', nome: 'Accendi', azione: () => inviaWol() },
  { id: 'riavvia', icona: 'riavvia', nome: 'Riavvia TV', azione: riavviaTv, classe: 'pericolo' },
];

function creaControlli() {
  const riga = $('#riga-controlli');
  CONTROLLI.forEach((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.id = 'ctl-' + c.id;
    b.className = 'focusable tile tile-controllo' + (c.classe ? ' ' + c.classe : '');
    b.innerHTML = `<span class="tile-icona"><svg viewBox="0 0 24 24">${ICONE_CONTROLLI[c.icona]}</svg></span>` +
      `<span class="ctl-testi"><span class="tile-nome">${c.nome}</span><span class="tile-valore" id="ctl-${c.id}-valore"></span></span>`;
    b.addEventListener('click', c.azione);
    riga.appendChild(b);
  });
  aggiornaImmagineUI();
  aggiornaTimerUI();
  aggiornaWolUI();
}

// ---------- Ingresso ----------

// Ingressi esterni della TV (HDMI…): { etichetta, nome, valore = appId }
async function elencoIngressi() {
  let ingressi = [];
  if (IS_WEBOS) {
    try {
      const r = await lunaConFallback('luna://com.webos.service.eim/getAllInputStatus', {});
      ingressi = (r.devices || r.inputs || []).filter((d) => d.appId).map((d) => ({
        etichetta: (d.label || d.id) + (d.connected === false ? ' (scollegato)' : ''),
        nome: d.label || d.id,
        valore: d.appId,
      }));
    } catch (e) { /* elenco standard qui sotto */ }
  }
  if (!ingressi.length) ingressi = [1, 2, 3, 4].map((n) => ({ etichetta: 'HDMI ' + n, nome: 'HDMI ' + n, valore: 'com.webos.app.hdmi' + n }));
  return ingressi;
}

async function scegliIngresso() {
  const ingressi = await elencoIngressi();
  ingressi.unshift({ etichetta: 'Live TV', valore: 'com.webos.app.livetv' });
  const ultimo = recenti.find((id) => INGRESSO.test(id));
  ingressi.forEach((i) => { i.attiva = i.valore === ultimo; });
  ingressi.push({ etichetta: 'Annulla', valore: null });

  const id = await scegli('Ingresso', ingressi);
  if (id) avviaApp({ id, title: nomeIngresso(id) });
}

// ---------- Modalità immagine ----------

// La TV tiene una modalità per ogni ingresso (Live TV, ogni HDMI, app). Letta senza "dimension"
// darebbe quella della dashboard stessa (app, sempre uguale): si usa quella dell'ultima sorgente guardata.
function sorgenteImmagine() {
  const escluse = new Set([...ESCLUSE, ...(config.homeIds || []), ...(config.salvaschermoIds || [])]);
  const id = recenti.find((x) => !escluse.has(x)) || '';
  const hdmi = id.match(/hdmi(\d+)$/);
  if (hdmi) return { input: 'hdmi' + hdmi[1], nome: 'HDMI ' + hdmi[1] };
  if (/livetv$/.test(id)) return { input: 'dtv', nome: 'Live TV' };
  return { input: 'default', nome: 'app' };
}

const dimensioneImmagine = () => ({ input: sorgenteImmagine().input, dynamicRange: 'sdr' });

async function leggiImmagine() {
  if (!IS_WEBOS) { aggiornaImmagineUI(); return; }
  try {
    const r = await lunaConFallback('luna://com.webos.settingsservice/getSystemSettings',
      { category: 'picture', keys: ['pictureMode'], dimension: dimensioneImmagine() });
    modoImmagine = (r.settings && r.settings.pictureMode) || null;
  } catch (e) { /* resta l'ultimo valore */ }
  aggiornaImmagineUI();
}

function aggiornaImmagineUI() {
  const valore = $('#ctl-immagine-valore');
  if (valore) valore.textContent = modoImmagine ? `${nomeModalita(modoImmagine)} · ${sorgenteImmagine().nome}` : '';
}

async function scegliImmagine() {
  const modi = MODI_SCEGLIBILI.includes(modoImmagine) || !modoImmagine ? MODI_SCEGLIBILI : [modoImmagine, ...MODI_SCEGLIBILI];
  const v = await scegli('Modalità immagine · ' + sorgenteImmagine().nome, [
    ...modi.map((m) => ({ etichetta: nomeModalita(m), valore: m, attiva: m === modoImmagine })),
    { etichetta: 'Annulla', valore: null },
  ]);
  if (!v) return;
  if (IS_WEBOS) {
    try {
      await lunaConFallback('luna://com.webos.settingsservice/setSystemSettings',
        { category: 'picture', settings: { pictureMode: v }, dimension: dimensioneImmagine() });
    } catch (e) {
      toast('Modalità non disponibile con questo segnale: ' + e.message);
      return;
    }
  }
  modoImmagine = v;
  aggiornaImmagineUI();
  toast('Immagine: ' + nomeModalita(v));
}

// ---------- Timer di spegnimento (gestito da servizio.sh, sopravvive alla chiusura della dashboard) ----------

function minutiRimanenti() {
  return fineTimer ? Math.ceil((fineTimer * 1000 - Date.now()) / 60000) : 0;
}

function aggiornaTimerUI() {
  if (fineTimer && minutiRimanenti() <= 0) fineTimer = 0;
  const valore = $('#ctl-timer-valore');
  if (valore) valore.textContent = fineTimer ? `tra ${minutiRimanenti()} min` : 'Off';
}

async function leggiTimer() {
  if (!IS_WEBOS) return;
  try {
    fineTimer = Number((await servizio('stato-timer')).trim()) || 0;
  } catch (e) { /* resta il valore noto */ }
  aggiornaTimerUI();
}

async function scegliTimer() {
  const attuale = minutiRimanenti();
  const v = await scegli('Spegnimento automatico', [
    { etichetta: 'Off', valore: '0', attiva: !fineTimer },
    ...[15, 30, 60, 90, 120].map((m) => ({ etichetta: m + ' minuti', valore: String(m) })),
    ...(attuale ? [{ etichetta: `Lascia com'è (${attuale} min)`, valore: null }] : [{ etichetta: 'Annulla', valore: null }]),
  ]);
  if (v === null) return;
  const minuti = Number(v);
  if (IS_WEBOS) {
    try {
      await servizio(minuti ? `timer ${minuti}` : 'annulla-timer');
    } catch (e) {
      toast('Timer non impostato: ' + e.message);
      return;
    }
  }
  fineTimer = minuti ? Math.floor(Date.now() / 1000) + minuti * 60 : 0;
  aggiornaTimerUI();
  toast(minuti ? `La TV si spegnerà tra ${minuti} minuti` : 'Timer annullato');
}

// ---------- Spegnimento ----------

async function spegniTv() {
  const ok = await scegli('Spegnere la TV?', [
    { etichetta: 'Spegni', valore: true },
    { etichetta: 'Annulla', valore: null },
  ]);
  if (!ok) return;
  if (!IS_WEBOS) { toast('TV spenta (simulato)'); return; }
  try {
    await servizio('spegni');
  } catch (e) {
    toast('Spegnimento non riuscito: ' + e.message);
  }
}

async function spegniSchermo() {
  if (!IS_WEBOS) { toast('Schermo spento (simulato)'); return; }
  try {
    await lunaConFallback('luna://com.webos.service.tvpower/power/turnOffScreen', {});
  } catch (e) {
    toast('Impossibile spegnere lo schermo: ' + e.message);
  }
}

// ---------- Accensione a distanza (Wake-on-LAN, inviato dalla TV con wol.py) ----------

// MAC scritto in qualsiasi forma (":" "-" o niente) → AA:BB:CC:DD:EE:FF; '' se non valido
function normalizzaMac(testo) {
  const hex = String(testo || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  return hex.length === 12 ? hex.match(/../g).join(':') : '';
}

const nomeWol = () => impostazioni.wolNome || 'dispositivo';

async function inviaWol() {
  if (!impostazioni.wolMac) {
    toast('Imposta prima il MAC in Impostazioni → Accensione a distanza');
    return false;
  }
  if (!IS_WEBOS) { toast(`Accensione di ${nomeWol()} inviata (simulato)`); return true; }
  try {
    const out = (await sh(`python3 ${shQuote(cartellaApp() + '/wol.py')} ${shQuote(impostazioni.wolMac)} 2>&1`)).trim();
    if (!/^ok\b/.test(out)) throw new Error(out || 'nessuna risposta');
    toast(`Accensione di ${nomeWol()} inviata`);
    return true;
  } catch (e) {
    toast(`Accensione di ${nomeWol()} non riuscita: ${e.message}`);
    return false;
  }
}

// Scegliendo l'ingresso collegato (menu Ingresso, barra delle app) il dispositivo si accende da solo
function wolPerIngresso(appId) {
  if (impostazioni.wolMac && impostazioni.wolIngresso && appId === impostazioni.wolIngresso) inviaWol();
}

function aggiornaWolUI() {
  const b = $('#ctl-wol');
  if (!b) return;
  b.style.display = impostazioni.wolMac && impostazioni.wolPulsante ? '' : 'none';
  b.querySelector('.tile-nome').textContent = 'Accendi ' + nomeWol();
}

async function riavviaTv() {
  const ok = await scegli('Riavviare la TV?', [
    { etichetta: 'Riavvia', valore: true },
    { etichetta: 'Annulla', valore: null },
  ]);
  if (!ok) return;
  if (!IS_WEBOS) { toast('TV riavviata (simulato)'); return; }
  try {
    await servizio('riavvia');
    toast('Riavvio in corso…');
  } catch (e) {
    toast('Riavvio non riuscito: ' + e.message);
  }
}
