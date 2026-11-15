'use strict';

// Card "Casa": entità di Home Assistant divise in gruppi.
// Si gestisce da Home Assistant: ogni entità con un'etichetta "TV: <gruppo>" (es. "TV: Clima") compare
// nel gruppo omonimo. Senza etichette valgono i gruppi di config.json (homeAssistant.gruppi).

const INTERVALLO_CASA = 30 * 1000;
const DOMINI_COMMUTABILI = ['light', 'switch', 'fan', 'input_boolean', 'cover', 'automation'];
const PREFISSO_ETICHETTE = 'TV: ';

const STATI = {
  on: 'Acceso', off: 'Spento', open: 'Aperto', closed: 'Chiuso', opening: 'In apertura', closing: 'In chiusura',
  home: 'A casa', not_home: 'Fuori', unavailable: 'Offline', unknown: 'Sconosciuto',
  docked: 'In base', cleaning: 'Sta pulendo', returning: 'Rientra', paused: 'In pausa', idle: 'Fermo', error: 'Errore',
  heat: 'Riscalda', cool: 'Raffredda', auto: 'Automatico', dry: 'Deumidifica', fan_only: 'Ventilazione', heat_cool: 'Automatico',
};

const casaDemo = [
  { nome: 'Luci e prese', entita: [
    { entity_id: 'light.soggiorno', state: 'on', attributes: { friendly_name: 'Luce soggiorno' } },
    { entity_id: 'light.cucina', state: 'off', attributes: { friendly_name: 'Luce cucina' } },
    { entity_id: 'switch.presa_tv', state: 'on', attributes: { friendly_name: 'Presa TV' } },
  ] },
  { nome: 'Clima', entita: [
    { entity_id: 'sensor.temperatura', state: '21.4', attributes: { friendly_name: 'Temperatura salotto', unit_of_measurement: '°C' } },
    { entity_id: 'sensor.umidita', state: '48', attributes: { friendly_name: 'Umidità salotto', unit_of_measurement: '%' } },
  ] },
  { nome: 'Altro', entita: [
    { entity_id: 'cover.tapparella', state: 'closed', attributes: { friendly_name: 'Tapparella' } },
  ] },
];

const dominio = (id) => id.split('.')[0];

// Entità in config.json: un id ("light.sala") oppure { "id": "...", "nome": "Nome da mostrare" }.
// "nomi" ({ id: nome }) cambia il nome mostrato anche per le entità prese dalle etichette.
function configCasa() {
  const ha = config.homeAssistant;
  if (!ha || !ha.url || !ha.token) return null;
  const nomi = Object.assign({}, ha.nomi || {});
  const leggiEntita = (lista) => (Array.isArray(lista) ? lista : []).map((e) => {
    const x = typeof e === 'string' ? { id: e } : (e || {});
    if (x.id && x.nome) nomi[x.id] = x.nome;
    return x.id;
  }).filter(Boolean);
  let gruppi = [];
  if (Array.isArray(ha.gruppi)) gruppi = ha.gruppi.map((g) => ({ nome: g.nome || '', entita: leggiEntita(g.entita) }));
  else if (Array.isArray(ha.entita)) gruppi = [{ nome: '', entita: leggiEntita(ha.entita) }];
  return {
    url: ha.url.replace(/\/+$/, ''),
    token: ha.token,
    gruppi,
    nomi,
    ordine: Array.isArray(ha.ordineGruppi) ? ha.ordineGruppi : gruppi.map((g) => g.nome),
  };
}

// Coppie [gruppo, entità] dalle etichette "TV: <gruppo>", tramite l'API dei template di Home Assistant
const TEMPLATE_ETICHETTE = '{% set ns = namespace(out=[]) %}{% for l in labels() %}{% set n = label_name(l) %}' +
  `{% if n.startswith('${PREFISSO_ETICHETTE}') %}{% for e in label_entities(l) %}` +
  `{% set ns.out = ns.out + [[n[${PREFISSO_ETICHETTE.length}:], e]] %}{% endfor %}{% endif %}{% endfor %}` +
  '{{ ns.out | tojson }}';

async function gruppiDaEtichette(ha) {
  const testo = await fetchTesto(ha.url + '/api/template', {
    metodo: 'POST',
    intestazioni: { Authorization: 'Bearer ' + ha.token, 'Content-Type': 'application/json' },
    corpo: JSON.stringify({ template: TEMPLATE_ETICHETTE }),
  });
  const perGruppo = new Map();
  JSON.parse(testo).forEach(([gruppo, id]) => {
    const nome = String(gruppo).trim();
    if (!perGruppo.has(nome)) perGruppo.set(nome, []);
    if (!perGruppo.get(nome).includes(id)) perGruppo.get(nome).push(id);
  });
  // Gruppi: ordine di config.json, poi gli altri in ordine alfabetico, "Altro" in fondo.
  // Entità: ordine di config.json se c'erano, le nuove in coda.
  const posGruppo = (n) => {
    const i = ha.ordine.indexOf(n);
    if (i >= 0) return i;
    return n.toLowerCase() === 'altro' ? 2000 : 1000;
  };
  const note = ha.gruppi.flatMap((g) => g.entita);
  const posEntita = (id) => (note.indexOf(id) < 0 ? 9999 : note.indexOf(id));
  return [...perGruppo.keys()]
    .sort((x, y) => posGruppo(x) - posGruppo(y) || x.localeCompare(y, 'it'))
    .map((nome) => ({
      nome,
      entita: perGruppo.get(nome).sort((x, y) => posEntita(x) - posEntita(y) || x.localeCompare(y)),
    }));
}

async function aggiornaCasa() {
  const ha = configCasa();
  const stato = $('#casa-stato');
  if (!ha) {
    if (!IS_WEBOS) {
      stato.textContent = 'dati demo';
      disegnaCasa(casaDemo);
    } else {
      $('#casa-entita').innerHTML = '<div class="messaggio">Collega Home Assistant in config.json ' +
        '(url e token), poi reinstalla con installa.sh.</div>';
    }
    return;
  }
  try {
    let gruppi = null;
    try { gruppi = await gruppiDaEtichette(ha); } catch (e) { /* niente etichette leggibili: config.json */ }
    if (!gruppi || !gruppi.length) gruppi = ha.gruppi.filter((g) => g.entita.length);
    if (!gruppi.length) {
      $('#casa-entita').innerHTML = '<div class="messaggio">In Home Assistant assegna alle entità ' +
        `un'etichetta «${PREFISSO_ETICHETTE}nome gruppo», per esempio «${PREFISSO_ETICHETTE}Clima».</div>`;
      stato.textContent = '';
      return;
    }
    const testo = await fetchTesto(ha.url + '/api/states', { intestazioni: { Authorization: 'Bearer ' + ha.token } });
    const perId = new Map(JSON.parse(testo).map((s) => [s.entity_id, s]));
    disegnaCasa(gruppi.map((g) => ({
      nome: g.nome,
      entita: g.entita.map((id) => {
        const s = perId.get(id) || { entity_id: id, state: 'non trovata', attributes: {} };
        const nome = ha.nomi[id];
        return nome ? Object.assign({}, s, { attributes: Object.assign({}, s.attributes, { friendly_name: nome }) }) : s;
      }),
    })));
    stato.textContent = '';
  } catch (e) {
    stato.textContent = 'non raggiungibile';
  }
}

const numeroIt = (n, decimali) => Number(n).toLocaleString('it-IT', { maximumFractionDigits: decimali });

function formattaStato(s) {
  const a = s.attributes;
  if (dominio(s.entity_id) === 'climate') {
    if (a.current_temperature === undefined) return STATI[s.state] || s.state;
    // Compatto per stare in tre colonne: acceso/spento lo dice l'evidenziazione della casella
    const attuale = numeroIt(a.current_temperature, 1) + '°';
    if (s.state === 'off' || a.temperature === undefined) return attuale;
    return `${attuale}→${numeroIt(a.temperature, 1)}°`;
  }
  const unita = a.unit_of_measurement;
  if (unita && s.state !== '' && !isNaN(Number(s.state))) {
    return `${numeroIt(s.state, unita === 'W' ? 0 : 1)} ${unita}`;
  }
  if (unita && !STATI[s.state]) return `${s.state} ${unita}`;
  return STATI[s.state] || s.state;
}

function creaEntita(s) {
  const commutabile = DOMINI_COMMUTABILI.includes(dominio(s.entity_id));
  const el = document.createElement(commutabile ? 'button' : 'div');
  const climaAcceso = dominio(s.entity_id) === 'climate' && !['off', 'unavailable', 'unknown'].includes(s.state);
  el.className = 'entita' + (commutabile ? ' focusable commutabile' : '') +
    (['on', 'open'].includes(s.state) || climaAcceso ? ' acceso' : '');
  el.dataset.entita = s.entity_id;
  el.innerHTML = `<span class="nome">${escapeHtml(s.attributes.friendly_name || s.entity_id)}</span>` +
    `<span class="valore">${escapeHtml(formattaStato(s))}</span>`;
  if (commutabile) {
    el.type = 'button';
    el.addEventListener('click', () => commutaEntita(s.entity_id));
  }
  return el;
}

function disegnaCasa(gruppi) {
  const box = $('#casa-entita');
  const attivo = document.activeElement && document.activeElement.dataset.entita;
  box.innerHTML = '';
  const totale = gruppi.reduce((n, g) => n + g.entita.length, 0);
  // Molte entità: tre colonne e caselle più basse perché stiano tutte nella card
  box.classList.toggle('fitta', totale > 10);
  gruppi.forEach((g) => {
    if (g.nome) {
      const titolo = document.createElement('div');
      titolo.className = 'gruppo-titolo';
      titolo.textContent = g.nome;
      box.appendChild(titolo);
    }
    g.entita.forEach((s) => {
      const el = creaEntita(s);
      box.appendChild(el);
      if (attivo === s.entity_id && el.classList.contains('focusable')) el.focus({ preventScroll: true });
    });
  });
}

async function commutaEntita(id) {
  const ha = configCasa();
  if (!ha) {
    // Anteprima: commuta i dati dimostrativi
    casaDemo.forEach((g) => g.entita.forEach((s) => {
      if (s.entity_id === id) s.state = { on: 'off', off: 'on', open: 'closed', closed: 'open' }[s.state] || s.state;
    }));
    disegnaCasa(casaDemo);
    return;
  }
  try {
    await fetchTesto(`${ha.url}/api/services/${dominio(id)}/toggle`, {
      metodo: 'POST',
      intestazioni: { Authorization: 'Bearer ' + ha.token, 'Content-Type': 'application/json' },
      corpo: JSON.stringify({ entity_id: id }),
    });
    setTimeout(aggiornaCasa, 600);
  } catch (e) {
    toast('Home Assistant non risponde: ' + e.message);
  }
}
