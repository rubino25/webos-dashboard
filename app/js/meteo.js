'use strict';

// Meteo da Open-Meteo (senza chiave API): condizioni attuali, 5 giorni e allerta per le prossime 12 ore

const INTERVALLO_METEO = 15 * 60 * 1000;
const RIPROVA_METEO = 2 * 60 * 1000;

const NUVOLA = 'M18 50h28a11 11 0 0 0 1-22 15 15 0 0 0-29-2 12 12 0 0 0 0 24z';
const NUVOLA_ALTA = 'M18 40h28a11 11 0 0 0 1-22 15 15 0 0 0-29-2 12 12 0 0 0 0 24z';

const ICONE = {
  sole: '<circle class="sole" cx="32" cy="32" r="12"/>' +
    [0, 45, 90, 135, 180, 225, 270, 315].map((a) =>
      `<rect class="sole" x="30" y="4" width="4" height="10" rx="2" transform="rotate(${a} 32 32)"/>`).join(''),
  luna: '<path class="luna" d="M40 8a22 22 0 1 0 16 34A18 18 0 0 1 40 8z"/>',
  parziale: '<circle class="sole" cx="24" cy="22" r="10"/>' +
    [0, 60, 120, 180, 240, 300].map((a) =>
      `<rect class="sole" x="22.5" y="4" width="3" height="7" rx="1.5" transform="rotate(${a} 24 22)"/>`).join('') +
    `<path class="nuvola" d="${NUVOLA}"/>`,
  parzialeNotte: '<path class="luna" d="M28 6a16 16 0 1 0 12 26A13 13 0 0 1 28 6z"/>' + `<path class="nuvola" d="${NUVOLA}"/>`,
  nuvola: '<path class="nuvola-scura" d="M30 34h22a9 9 0 0 0 0-18 12 12 0 0 0-23-1z"/>' + `<path class="nuvola" d="${NUVOLA}"/>`,
  nebbia: `<path class="nuvola" d="${NUVOLA_ALTA}"/>` +
    '<line class="nebbia" x1="10" y1="48" x2="54" y2="48"/><line class="nebbia" x1="16" y1="57" x2="48" y2="57"/>',
  pioggia: `<path class="nuvola" d="${NUVOLA_ALTA}"/>` +
    '<line class="goccia" x1="22" y1="48" x2="19" y2="58"/><line class="goccia" x1="33" y1="48" x2="30" y2="58"/><line class="goccia" x1="44" y1="48" x2="41" y2="58"/>',
  neve: `<path class="nuvola" d="${NUVOLA_ALTA}"/>` +
    '<circle class="fiocco" cx="21" cy="51" r="3"/><circle class="fiocco" cx="33" cy="56" r="3"/><circle class="fiocco" cx="45" cy="51" r="3"/>',
  temporale: `<path class="nuvola" d="${NUVOLA_ALTA}"/>` + '<path class="fulmine" d="M34 40l-10 14h8l-4 10 12-16h-8l4-8z"/>',
  vento: '<path class="nebbia" fill="none" d="M8 24h30a7 7 0 1 0-7-7M8 34h40a7 7 0 1 1-7 7M8 44h22"/>',
  gelo: '<g class="nebbia"><line x1="32" y1="8" x2="32" y2="56"/><line x1="11" y1="20" x2="53" y2="44"/><line x1="11" y1="44" x2="53" y2="20"/></g>',
};

function icona(nome) {
  return `<svg viewBox="0 0 64 64">${ICONE[nome] || ICONE.nuvola}</svg>`;
}

// Codici WMO -> [descrizione, icona di giorno, icona di notte]
function decodificaMeteo(codice) {
  const t = {
    0: ['Sereno', 'sole', 'luna'],
    1: ['Prevalentemente sereno', 'parziale', 'parzialeNotte'],
    2: ['Parzialmente nuvoloso', 'parziale', 'parzialeNotte'],
    3: ['Coperto', 'nuvola'],
    45: ['Nebbia', 'nebbia'], 48: ['Nebbia con brina', 'nebbia'],
    51: ['Pioviggine debole', 'pioggia'], 53: ['Pioviggine', 'pioggia'], 55: ['Pioviggine intensa', 'pioggia'],
    56: ['Pioviggine gelata', 'pioggia'], 57: ['Pioviggine gelata', 'pioggia'],
    61: ['Pioggia debole', 'pioggia'], 63: ['Pioggia', 'pioggia'], 65: ['Pioggia forte', 'pioggia'],
    66: ['Pioggia gelata', 'pioggia'], 67: ['Pioggia gelata forte', 'pioggia'],
    71: ['Neve debole', 'neve'], 73: ['Neve', 'neve'], 75: ['Neve forte', 'neve'], 77: ['Granuli di neve', 'neve'],
    80: ['Rovesci deboli', 'pioggia'], 81: ['Rovesci', 'pioggia'], 82: ['Rovesci violenti', 'pioggia'],
    85: ['Rovesci di neve', 'neve'], 86: ['Forti rovesci di neve', 'neve'],
    95: ['Temporale', 'temporale'], 96: ['Temporale con grandine', 'temporale'], 99: ['Temporale con grandine', 'temporale'],
  };
  const voce = t[codice] || ['—', 'nuvola'];
  return { descrizione: voce[0], giorno: voce[1], notte: voce[2] || voce[1] };
}

// Ultimo meteo, usato anche dal salvaschermo
let ultimoMeteo = null;
let timerMeteo;

async function aggiornaMeteo() {
  clearTimeout(timerMeteo);
  const stato = $('#meteo-stato');
  $('#meteo-luogo').textContent = impostazioni.citta;
  const url = 'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${impostazioni.lat}&longitude=${impostazioni.lon}` +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    '&hourly=temperature_2m,precipitation_probability,weather_code,wind_gusts_10m' +
    '&timezone=auto&forecast_days=5&forecast_hours=12';
  try {
    const risposta = await fetch(url);
    if (!risposta.ok) throw new Error('HTTP ' + risposta.status);
    const dati = await risposta.json();
    disegnaMeteo(dati);
    disegnaAllerta(calcolaAllerta(dati.hourly));
    stato.classList.remove('errore');
    stato.textContent = 'agg. ' + oraMinuti(new Date());
    timerMeteo = setTimeout(aggiornaMeteo, INTERVALLO_METEO);
  } catch (e) {
    stato.classList.add('errore');
    stato.textContent = 'Meteo non disponibile (' + e.message + ')';
    timerMeteo = setTimeout(aggiornaMeteo, RIPROVA_METEO);
  }
}

function disegnaMeteo(dati) {
  const c = dati.current;
  const m = decodificaMeteo(c.weather_code);
  const nomeIcona = c.is_day ? m.giorno : m.notte;
  ultimoMeteo = { temperatura: Math.round(c.temperature_2m), descrizione: m.descrizione, icona: nomeIcona };
  aggiornaMeteoSalvaschermo();

  $('#meteo-corrente').innerHTML = `
    <div class="icona-grande">${icona(nomeIcona)}</div>
    <div>
      <div class="temp">${Math.round(c.temperature_2m)}°</div>
      <div class="descrizione">${m.descrizione}</div>
      <div class="extra">
        Percepita ${Math.round(c.apparent_temperature)}° · Umidità ${c.relative_humidity_2m}%<br>
        Vento ${Math.round(c.wind_speed_10m)} km/h
      </div>
    </div>`;

  const d = dati.daily;
  $('#meteo-previsioni').innerHTML = d.time.map((giorno, i) => {
    const nome = i === 0 ? 'Oggi'
      : maiuscola(new Date(giorno + 'T12:00:00').toLocaleDateString('it-IT', { weekday: 'short' }).replace('.', ''));
    const pioggia = d.precipitation_probability_max ? d.precipitation_probability_max[i] : null;
    return `
      <div class="giorno">
        <div class="nome">${nome}</div>
        ${icona(decodificaMeteo(d.weather_code[i]).giorno)}
        <div class="minmax">${Math.round(d.temperature_2m_max[i])}°<span class="min">${Math.round(d.temperature_2m_min[i])}°</span></div>
        <div class="pioggia">${pioggia ? pioggia + '%' : ''}</div>
      </div>`;
  }).join('');
}

// Il fenomeno più importante nelle prossime 12 ore (temporale > neve > pioggia > vento > gelo)
function calcolaAllerta(h) {
  if (!h || !h.time) return null;
  const trovati = {};
  h.time.forEach((t, i) => {
    const codice = h.weather_code[i];
    const quando = new Date(t);
    const segna = (tipo, extra) => { if (!trovati[tipo]) trovati[tipo] = Object.assign({ quando, indice: i }, extra); };
    if (codice >= 95) segna('temporale');
    else if ((codice >= 71 && codice <= 77) || codice === 85 || codice === 86) segna('neve');
    else if ((codice >= 51 && codice <= 67) || (codice >= 80 && codice <= 82) || h.precipitation_probability[i] >= 60) {
      segna('pioggia', { probabilita: h.precipitation_probability[i] });
    }
    if (h.wind_gusts_10m[i] >= 60) segna('vento', { raffiche: Math.round(h.wind_gusts_10m[i]) });
    if (h.temperature_2m[i] <= 0) segna('gelo');
  });

  const testi = {
    temporale: (a) => `Temporale ${quandoAllerta(a)}`,
    neve: (a) => `Neve ${quandoAllerta(a)}`,
    pioggia: (a) => `Pioggia ${quandoAllerta(a)}` + (a.probabilita ? ` (${a.probabilita}%)` : ''),
    vento: (a) => `Raffiche fino a ${a.raffiche} km/h ${quandoAllerta(a)}`,
    gelo: (a) => `Gelo ${quandoAllerta(a)}`,
  };
  const icone = { temporale: 'temporale', neve: 'neve', pioggia: 'pioggia', vento: 'vento', gelo: 'gelo' };
  for (const tipo of ['temporale', 'neve', 'pioggia', 'vento', 'gelo']) {
    if (trovati[tipo]) return { testo: testi[tipo](trovati[tipo]), icona: icone[tipo] };
  }
  return null;
}

function quandoAllerta(a) {
  return a.indice === 0 ? 'in corso' : 'dalle ' + oraMinuti(a.quando);
}

function disegnaAllerta(allerta) {
  const el = $('#allerta');
  el.hidden = !allerta;
  if (allerta) el.innerHTML = icona(allerta.icona) + `<span>${allerta.testo}</span>`;
}

async function cercaCitta(nome) {
  const url = 'https://geocoding-api.open-meteo.com/v1/search' +
    `?name=${encodeURIComponent(nome)}&count=1&language=it&format=json`;
  const risposta = await fetch(url);
  if (!risposta.ok) throw new Error('HTTP ' + risposta.status);
  const dati = await risposta.json();
  if (!dati.results || !dati.results.length) throw new Error('Città non trovata');
  return dati.results[0];
}
