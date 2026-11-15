'use strict';

// Card "Sistema": statistiche lette come root con un solo comando ogni pochi secondi

const INTERVALLO_SISTEMA = 3000;

// Una riga "chiave=valore" per metrica; i campi assenti vengono semplicemente ignorati
const COMANDO_STATISTICHE = [
  "awk '{print \"uptime=\"$1}' /proc/uptime",
  "awk '/^cpu /{print \"cpu=\"($2+$3+$4+$5+$6+$7+$8+$9)\" \"($5+$6)}' /proc/stat",
  "awk '/^MemTotal/{print \"memTotale=\"$2} /^MemAvailable/{print \"memLibera=\"$2}' /proc/meminfo",
  "df -Pk /media/internal 2>/dev/null | awk 'NR==2{print \"disco=\"$2\" \"$3}'",
  "awk '{print \"carico=\"$1\" \"$2\" \"$3}' /proc/loadavg",
  "cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null | awk '{print \"temp=\"$1}'",
  "ls -d /proc/[0-9]* | wc -l | awk '{print \"processi=\"$1}'",
  "ip -o -4 addr show 2>/dev/null | awk '$2!=\"lo\"{split($4,a,\"/\"); print \"ip=\"$2\" \"a[1]}'",
  "awk 'NR>2{gsub(\":\",\" \"); print \"net=\"$1\" \"$2\" \"$10}' /proc/net/dev",
  "awk 'NR>2{gsub(\":\",\" \"); print \"wifi=\"$1\" \"$4}' /proc/net/wireless 2>/dev/null",
].join('; ');

const MODALITA_IMMAGINE = {
  vivid: 'Vivace', standard: 'Standard', eco: 'Eco', energySaving: 'Risparmio', cinema: 'Cinema',
  sports: 'Sport', game: 'Gioco', filmMaker: 'Filmmaker', expert1: 'Esperto chiaro',
  expert2: 'Esperto scuro', photo: 'Foto', hdrVivid: 'HDR vivace', hdrStandard: 'HDR standard',
  hdrCinema: 'HDR cinema', hdrFilmMaker: 'HDR filmmaker', dolbyHdrVivid: 'Dolby vivace',
  dolbyHdrStandard: 'Dolby standard', dolbyHdrCinema: 'Dolby cinema', dolbyHdrCinemaBright: 'Dolby cinema chiaro',
  dolbyHdrGame: 'Dolby gioco', normal: 'Normale', personalized: 'Personalizzata',
};

const nomeModalita = (m) => MODALITA_IMMAGINE[m] || maiuscola(m);

function leggiChiaveValore(testo) {
  const out = { ip: [], net: [], wifi: [] };
  testo.split('\n').forEach((riga) => {
    const i = riga.indexOf('=');
    if (i <= 0) return;
    const chiave = riga.slice(0, i).trim();
    const valore = riga.slice(i + 1).trim();
    if (Array.isArray(out[chiave])) out[chiave].push(valore);
    else out[chiave] = valore;
  });
  return out;
}

function formattaKB(kb) {
  const gb = kb / 1048576;
  return gb >= 1 ? gb.toFixed(1).replace('.', ',') + ' GB' : Math.round(kb / 1024) + ' MB';
}

function formattaVelocita(bytesAlSecondo) {
  const bit = bytesAlSecondo * 8;
  if (bit >= 1e6) return (bit / 1e6).toFixed(1).replace('.', ',') + ' Mbit/s';
  if (bit >= 1e3) return Math.round(bit / 1e3) + ' kbit/s';
  return Math.round(bit) + ' bit/s';
}

function formattaUptime(secondi) {
  const g = Math.floor(secondi / 86400);
  const h = Math.floor((secondi % 86400) / 3600);
  const m = Math.floor((secondi % 3600) / 60);
  if (g > 0) return `${g} g ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

function qualitaWifi(dbm) {
  if (dbm >= -55) return 'ottimo';
  if (dbm >= -67) return 'buono';
  if (dbm >= -75) return 'discreto';
  return 'debole';
}

function impostaBarra(id, frazione) {
  const el = $(id);
  const p = Math.max(0, Math.min(1, frazione));
  el.style.width = (p * 100).toFixed(1) + '%';
  el.classList.toggle('medio', p >= 0.7 && p < 0.9);
  el.classList.toggle('alto', p >= 0.9);
}

let cpuPrecedente = null;
let retePrecedente = null;

async function aggiornaSistema() {
  if (document.hidden) return;
  const stato = $('#sistema-stato');
  let testo;
  try {
    testo = IS_WEBOS ? await sh(COMANDO_STATISTICHE) : statisticheDemo();
  } catch (e) {
    stato.classList.add('errore');
    stato.textContent = 'Servizio root non disponibile: ' + e.message;
    return;
  }
  stato.classList.remove('errore');
  stato.textContent = IS_WEBOS ? '' : 'dati demo';

  const v = leggiChiaveValore(testo);

  if (v.cpu) {
    const [totale, inattivo] = v.cpu.split(' ').map(Number);
    if (cpuPrecedente && totale > cpuPrecedente.totale) {
      const uso = 1 - (inattivo - cpuPrecedente.inattivo) / (totale - cpuPrecedente.totale);
      $('#cpu-val').textContent = Math.round(uso * 100) + '%';
      impostaBarra('#cpu-barra', uso);
    }
    cpuPrecedente = { totale, inattivo };
  }

  if (v.memTotale && v.memLibera) {
    const totale = Number(v.memTotale);
    const usata = totale - Number(v.memLibera);
    $('#ram-val').textContent = `${formattaKB(usata)} / ${formattaKB(totale)}`;
    impostaBarra('#ram-barra', usata / totale);
  }

  if (v.disco) {
    const [totale, usato] = v.disco.split(' ').map(Number);
    $('#disco-val').textContent = `${formattaKB(usato)} / ${formattaKB(totale)}`;
    impostaBarra('#disco-barra', usato / totale);
  }

  if (v.uptime) $('#uptime').textContent = formattaUptime(Number(v.uptime));
  if (v.carico) $('#carico').textContent = v.carico.split(' ')[0].replace('.', ',');
  if (v.processi) $('#processi').textContent = v.processi;
  if (v.temp) {
    const t = Number(v.temp);
    $('#temp').textContent = Math.round(t > 1000 ? t / 1000 : t) + ' °C';
  }
  // La G6 (webOS 11.2) non espone sensori di temperatura: niente casella vuota
  $('#temp').parentElement.hidden = !v.temp;

  // Interfaccia principale: la prima cablata/wifi con un indirizzo IP
  const voceIp = v.ip.find((x) => /^(eth|wlan)/.test(x)) || v.ip[0];
  const interfaccia = voceIp ? voceIp.split(' ')[0] : null;
  if (voceIp) $('#ip').textContent = voceIp.split(' ')[1];

  if (interfaccia) {
    if (/^wlan/.test(interfaccia)) {
      const w = v.wifi.find((x) => x.startsWith(interfaccia + ' '));
      const dbm = w ? parseFloat(w.split(' ')[1]) : NaN;
      $('#connessione').textContent = isNaN(dbm) ? 'Wi-Fi' : `Wi-Fi, ${qualitaWifi(dbm)}`;
    } else {
      $('#connessione').textContent = 'Cablata';
    }

    const n = v.net.find((x) => x.startsWith(interfaccia + ' '));
    if (n) {
      const [, rx, tx] = n.split(' ').map(Number);
      const adesso = Date.now();
      if (retePrecedente && retePrecedente.interfaccia === interfaccia && rx >= retePrecedente.rx) {
        const dt = (adesso - retePrecedente.t) / 1000;
        $('#download').textContent = formattaVelocita((rx - retePrecedente.rx) / dt);
        $('#upload').textContent = formattaVelocita((tx - retePrecedente.tx) / dt);
      }
      retePrecedente = { interfaccia, rx, tx, t: adesso };
    }
  }
}

async function caricaInfoTv() {
  if (!IS_WEBOS) {
    $('#tv-modello').textContent = 'Anteprima nel browser';
    $('#webos').textContent = '26';
    $('#firmware').textContent = 'demo';
    return;
  }
  try {
    const r = await luna('luna://com.webos.service.tv.systemproperty/getSystemInfo',
      { keys: ['modelName', 'firmwareVersion', 'sdkVersion'] });
    if (r.modelName) $('#tv-modello').textContent = 'LG ' + r.modelName;
    if (r.firmwareVersion) $('#firmware').textContent = r.firmwareVersion;
    if (r.sdkVersion) $('#webos').textContent = r.sdkVersion;
  } catch (e) { /* proviamo comunque os_info */ }
  try {
    const os = JSON.parse(await sh('cat /var/run/nyx/os_info.json'));
    if (os.webos_release) $('#webos').textContent = os.webos_release;
  } catch (e) { /* lascia il valore precedente */ }
}

// ---------- Dati dimostrativi fuori dalla TV ----------

const demo = { totale: 1e6, inattivo: 8e5, rx: 5e9, tx: 3e8 };

function statisticheDemo() {
  const delta = 1000;
  demo.totale += delta;
  demo.inattivo += delta * (0.55 + Math.random() * 0.35);
  demo.rx += Math.round(2e6 + Math.random() * 1e6);
  demo.tx += Math.round(4e4 + Math.random() * 2e4);
  return [
    'uptime=' + (performance.now() / 1000 + 93784),
    `cpu=${demo.totale} ${Math.round(demo.inattivo)}`,
    'memTotale=4194304', 'memLibera=' + Math.round(1700000 + Math.random() * 150000),
    'disco=16515072 7134000',
    'carico=0.84 0.97 1.02',
    'temp=' + Math.round(52000 + Math.random() * 3000),
    'processi=231',
    'ip=wlan0 192.168.1.50',
    'net=lo 1000 1000', `net=wlan0 ${demo.rx} ${demo.tx}`,
    'wifi=wlan0 -58.',
  ].join('\n');
}
