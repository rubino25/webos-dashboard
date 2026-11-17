#!/usr/bin/env python3
# Pagina web di configurazione della dashboard, servita dalla TV:  http://<ip-tv>:8095
# La avvia servizio.sh (come root) insieme agli altri monitor; in attesa non usa CPU.
#
#   GET  /                  la pagina (configura.html)
#   GET  /api/stato         impostazioni, opzioni Home/salvaschermo, app installate, ingressi
#   GET  /icona?k=<chiave>  icona di un'app dell'elenco
#   GET  /api/sistema       stato della TV in breve, per il pannello touch ESP32 (lo interroga ogni 3 s): sola lettura
#   POST /api/impostazioni  {campo: valore, ...}: solo i campi previsti, controllati uno per uno
#   POST /api/opzioni       {home, accensione, salvaschermoLg}: le passa a servizio.sh
#   POST /api/wol           accende il dispositivo impostato (wol.py)
#   POST /api/spegni        spegne questa pagina (si riaccende dalla TV: Impostazioni → Pagina web)
#
# Le impostazioni stanno in /var/lib/webosbrew/dashboard/impostazioni.json, lo stesso file della dashboard.
# Dopo ogni modifica, se la dashboard è davanti, viene "rilanciata" con {ricarica: true} e le rilegge.
#
# /api/sistema risponde sempre con tutte le chiavi (null se il dato non c'è):
#   {"cpu": 23, "ram": {"usata": kB, "totale": kB}, "disco": {"usato": kB, "totale": kB}, "temp": °C | null,
#    "uptime": s, "carico": 0.84, "app": {"id", "nome"} | null, "sorgente": "Live TV" | "HDMI 2" | nome dell'app,
#    "canale": {"numero", "nome", "programma", "inizio", "fine"} | null      (solo con Live TV davanti),
#    "media": {"titolo", "posizione": s, "durata": s, "stato": "play"|"pause"} | null   (Media Player LG),
#    "immagine": "Cinema" | null, "volume": 12 | null, "muto": false | null,
#    "audio": {"uscita": "Soundbar (eARC)" | "Altoparlanti TV" | ..., "modalita": "AI Sound Pro" | "Cinema" | ...} | null,
#    "info": {"modello": "OLED55XXXXX", "webos": "x.y.z", "firmware": "xx.yy.zz", "dashboard": "1.7.3"},
#    "rete": {"connessione": "Wi-Fi" | "Cablata", "segnale": "ottimo"|"buono"|"discreto"|"debole" | null,
#             "ip": "192.168.1.50", "download": bit/s, "upload": bit/s} | null}
# Costo: /proc letto a ogni richiesta (CPU e rete col delta dalla lettura precedente); l'app davanti dal file
# primo_piano di servizio.sh; Luna solo con cache (volume 2 s, immagine e audio 10 s, canale 10 s, guida 10 min,
# titoli delle app 10 min; modello e versioni all'avvio) e mai più di ~0,2 s di attesa: oltre si risponde
# col valore precedente.
# Il film: abbonamento a com.webos.media finché il Media Player riproduce e qualcuno interroga (30 s),
# titolo dall'indice DLNA (dlna.py, in background). Nessuna richiesta, nessun lavoro.

import glob
import json
import os
import re
import subprocess
import threading
import time
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

PORTA = 8095
CARTELLA = os.path.dirname(os.path.abspath(__file__))
FILE_IMPOSTAZIONI = '/var/lib/webosbrew/dashboard/impostazioni.json'
APP_ID = 'it.casa.dashboard'
SERVIZIO = os.path.join(CARTELLA, 'servizio.sh')

blocco = threading.Lock()
icone = {}  # chiave dell'app → file dell'icona (solo quelle dell'ultimo elenco: niente percorsi arbitrari)
MIME = {'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'webp': 'image/webp', 'svg': 'image/svg+xml'}


class ErroreRichiesta(Exception):
    pass


def esegui(argomenti, attesa=10):
    return subprocess.run(argomenti, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          universal_newlines=True, timeout=attesa).stdout


def luna(uri, params=None):
    out = esegui(['luna-send', '-n', '1', '-w', '5000', uri, json.dumps(params or {})])
    try:
        r = json.loads(out)
    except ValueError:
        raise RuntimeError('risposta non valida da ' + uri)
    if r.get('returnValue') is False:
        raise RuntimeError(r.get('errorText') or 'errore da ' + uri)
    return r


# ---------- Impostazioni (file condiviso con la dashboard) ----------

def leggi_impostazioni():
    try:
        with open(FILE_IMPOSTAZIONI) as f:
            dati = json.load(f)
        return dati if isinstance(dati, dict) else {}
    except (OSError, ValueError):
        return {}


def scrivi_impostazioni(dati):
    os.makedirs(os.path.dirname(FILE_IMPOSTAZIONI), exist_ok=True)
    tmp = FILE_IMPOSTAZIONI + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(dati, f, ensure_ascii=False)
    os.replace(tmp, FILE_IMPOSTAZIONI)


def testo(massimo):
    def controlla(v):
        if not isinstance(v, str):
            raise ValueError('serve un testo')
        return v.strip()[:massimo]
    return controlla


def numero(minimo, massimo):
    def controlla(v):
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not minimo <= v <= massimo:
            raise ValueError('numero fuori intervallo')
        return v
    return controlla


def booleano(v):
    if not isinstance(v, bool):
        raise ValueError('serve sì o no')
    return v


def preferite(v):
    if not isinstance(v, list) or len(v) > 80 or not all(isinstance(k, str) and 0 < len(k) <= 200 for k in v):
        raise ValueError('elenco di app non valido')
    return list(dict.fromkeys(v))  # senza doppioni, nell'ordine dato


def minuti_salvaschermo(v):
    if v not in (0, 5, 10, 15, 30, 60):
        raise ValueError('valori ammessi: 0, 5, 10, 15, 30, 60')
    return v


def mac(v):
    if not isinstance(v, str):
        raise ValueError('serve un testo')
    cifre = re.sub(r'[^0-9a-fA-F]', '', v).upper()
    if not v.strip():
        return ''
    if len(cifre) != 12:
        raise ValueError('servono 12 cifre esadecimali, es. 00:11:22:33:44:55')
    return ':'.join(cifre[i:i + 2] for i in range(0, 12, 2))


def ingresso(v):
    if v != '' and not (isinstance(v, str) and re.match(r'^com\.webos\.app\.[\w.]+$', v)):
        raise ValueError('ingresso non valido')
    return v


CAMPI = {
    'citta': testo(80),
    'lat': numero(-90, 90),
    'lon': numero(-180, 180),
    'secondi': booleano,
    'preferite': preferite,
    'salvaschermoMin': minuti_salvaschermo,
    'wolNome': testo(20),
    'wolMac': mac,
    'wolIngresso': ingresso,
    'wolIngressoNome': testo(40),
    'wolPulsante': booleano,
}


def aggiorna_impostazioni(modifiche):
    if not isinstance(modifiche, dict) or not modifiche:
        raise ErroreRichiesta('nessuna modifica')
    pulite = {}
    for campo, valore in modifiche.items():
        if campo not in CAMPI:
            raise ErroreRichiesta('campo non modificabile da qui: ' + campo)
        try:
            pulite[campo] = CAMPI[campo](valore)
        except ValueError as e:
            raise ErroreRichiesta('%s: %s' % (campo, e))
    with blocco:
        dati = leggi_impostazioni()
        dati.update(pulite)
        scrivi_impostazioni(dati)
    avvisa_dashboard()
    return dati


# ---------- Opzioni di servizio.sh (Home, accensione, salvaschermo LG) ----------

def leggi_opzioni():
    v = dict(re.findall(r'^(\w+)=(.*)$', esegui(['sh', SERVIZIO, 'opzioni']), re.M))
    return {
        'home': v.get('HOME_DASHBOARD') == '1',
        'accensione': v.get('ACCENSIONE') == '1',
        'salvaschermoLg': v.get('SALVASCHERMO_LG') == '1',
        'web': v.get('PAGINA_WEB') != '0',
        'homeIds': v.get('HOME_IDS', 'com.webos.app.home').strip('"'),
        'salvaschermoIds': v.get('SALVASCHERMO_IDS', 'com.webos.app.screensaver').strip('"'),
    }


def aggiorna_opzioni(modifiche):
    if not isinstance(modifiche, dict):
        raise ErroreRichiesta('richiesta non valida')
    with blocco:
        attuali = leggi_opzioni()
        for campo in ('home', 'accensione', 'salvaschermoLg'):
            if campo in modifiche:
                attuali[campo] = booleano(modifiche[campo])
        esegui(['sh', SERVIZIO, 'imposta'] + ['1' if attuali[c] else '0' for c in ('home', 'accensione', 'salvaschermoLg')] +
               [attuali['homeIds'], attuali['salvaschermoIds']], 20)
    avvisa_dashboard()
    return leggi_opzioni()


# ---------- App, ingressi, avvisi alla dashboard ----------

def elenco_app():
    punti = luna('luna://com.webos.applicationManager/listLaunchPoints').get('launchPoints', [])
    app = []
    nuove_icone = {}
    for p in punti:
        if p.get('id') == APP_ID:
            continue
        chiave = p.get('launchPointId') or p.get('id')
        icona = re.sub(r'^file://', '', p.get('icon') or '')
        ha_icona = icona.startswith('/') and os.path.isfile(icona)
        if ha_icona:
            nuove_icone[chiave] = icona
        app.append({'chiave': chiave, 'id': p.get('id'), 'titolo': p.get('title') or p.get('id'),
                    'colore': p.get('bgColor') or '', 'icona': ha_icona})
    icone.clear()
    icone.update(nuove_icone)
    return app


def elenco_ingressi():
    try:
        r = luna('luna://com.webos.service.eim/getAllInputStatus')
        voci = [{'valore': d['appId'], 'nome': d.get('label') or d.get('id'), 'collegato': d.get('connected') is not False}
                for d in (r.get('devices') or r.get('inputs') or []) if d.get('appId')]
        if voci:
            return voci
    except Exception:
        pass
    return [{'valore': 'com.webos.app.hdmi%d' % n, 'nome': 'HDMI %d' % n, 'collegato': True} for n in range(1, 5)]


def avvisa_dashboard():
    # Solo se è davanti: rilanciarla da dietro la porterebbe in primo piano
    try:
        davanti = luna('luna://com.webos.applicationManager/getForegroundAppInfo').get('appId')
        if davanti == APP_ID:
            luna('luna://com.webos.applicationManager/launch', {'id': APP_ID, 'params': {'ricarica': True}})
    except Exception:
        pass  # la dashboard rilegge comunque il file quando torna visibile


def versione():
    try:
        with open(os.path.join(CARTELLA, 'appinfo.json')) as f:
            return json.load(f).get('version', '')
    except (OSError, ValueError):
        return ''


def spegni_pagina():
    # Prima il segno "spenta" e l'avviso alla dashboard (il pannello sulla TV mostra "Pagina web: No"),
    # poi servizio.sh "web off", che chiude anche questo processo: parte staccato, dopo la risposta al browser
    open(os.path.join(os.path.dirname(FILE_IMPOSTAZIONI), 'configura_spenta'), 'a').close()
    avvisa_dashboard()
    subprocess.Popen(['sh', '-c', 'sleep 1; sh "$0" web off', SERVIZIO], stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def accendi(dati):
    indirizzo = mac(dati.get('mac', '')) if isinstance(dati, dict) and dati.get('mac') else leggi_impostazioni().get('wolMac', '')
    if not indirizzo:
        raise ErroreRichiesta('MAC non impostato')
    out = esegui(['python3', os.path.join(CARTELLA, 'wol.py'), indirizzo]).strip()
    if not out.startswith('ok'):
        raise RuntimeError(out or 'invio non riuscito')
    return {'inviato': indirizzo, 'reti': out.split()[1:]}


# ---------- Stato per il pannello ESP32 (GET /api/sistema) ----------

DIR_DATI = os.path.dirname(FILE_IMPOSTAZIONI)
FILE_PRIMO_PIANO = os.path.join(DIR_DATI, 'primo_piano')        # scritto da servizio.sh a ogni cambio di app
FILE_POSIZIONI = os.path.join(DIR_DATI, 'film-posizioni.json')  # scritto da film/traccia.py
LIVETV = 'com.webos.app.livetv'
MEDIA_PLAYER = 'com.webos.app.mediadiscovery'
ATTESA_MAX = 0.2  # secondi che una richiesta aspetta i dati Luna nuovi, poi usa quelli di prima
EPOCA = datetime(1970, 1, 1)  # per le ore in UTC senza utcfromtimestamp (deprecato in Python 3.12, quello della TV)

# Nomi come in app/js/sistema.js
MODALITA_IMMAGINE = {
    'vivid': 'Vivace', 'standard': 'Standard', 'eco': 'Eco', 'energySaving': 'Risparmio', 'cinema': 'Cinema',
    'sports': 'Sport', 'game': 'Gioco', 'filmMaker': 'Filmmaker', 'expert1': 'Esperto chiaro',
    'expert2': 'Esperto scuro', 'photo': 'Foto', 'hdrVivid': 'HDR vivace', 'hdrStandard': 'HDR standard',
    'hdrCinema': 'HDR cinema', 'hdrFilmMaker': 'HDR filmmaker', 'hdrGame': 'HDR gioco', 'dolbyHdrVivid': 'Dolby vivace',
    'dolbyHdrStandard': 'Dolby standard', 'dolbyHdrCinema': 'Dolby cinema', 'dolbyHdrCinemaBright': 'Dolby cinema chiaro',
    'dolbyHdrGame': 'Dolby gioco', 'normal': 'Normale', 'personalized': 'Personalizzata',
}


def luna_dati(uri, params=None, attesa=4):
    # Come luna(), ma senza stderr (avvisi di luna-send) e accetta anche risposte che sono liste
    r = subprocess.run(['luna-send', '-n', '1', '-w', str(attesa * 1000), uri, json.dumps(params or {})],
                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=attesa + 2)
    for riga in r.stdout.decode('utf-8', 'replace').splitlines():
        try:
            dati = json.loads(riga)
        except ValueError:
            continue
        if isinstance(dati, dict) and dati.get('returnValue') is False:
            raise RuntimeError(dati.get('errorText') or 'errore da ' + uri)
        return dati
    raise RuntimeError('nessuna risposta da ' + uri)


class Memo:
    """Valore calcolato in background e tenuto per `durata` secondi; `chiave` diversa = da ricalcolare.
    Un solo calcolo alla volta: le richieste che arrivano nel frattempo usano il valore precedente."""

    def __init__(self, funzione, durata, riprova=None):
        # riprova: se il valore è incompleto (None, o un dizionario con dei None) si ricalcola dopo questi secondi
        self.funzione, self.durata, self.riprova = funzione, durata, riprova
        self.valore, self.chiave, self.quando = None, None, 0.0
        self.thread = None
        self.lock = threading.Lock()

    def aggiorna(self, chiave=None):
        # Avvia il ricalcolo se serve; restituisce il thread da aspettare (o None se il valore è fresco)
        with self.lock:
            durata = self.durata
            if self.riprova and (self.valore is None or (isinstance(self.valore, dict) and None in self.valore.values())):
                durata = self.riprova
            if self.quando and self.chiave == chiave and time.time() - self.quando < durata:
                return None
            if not (self.thread and self.thread.is_alive()):
                self.thread = threading.Thread(target=self._calcola, args=(chiave,), daemon=True)
                self.thread.start()
            return self.thread

    def _calcola(self, chiave):
        try:
            valore = self.funzione(chiave)
        except Exception:
            valore = None
        with self.lock:
            self.valore, self.chiave, self.quando = valore, chiave, time.time()

    def leggi(self, chiave=None):
        with self.lock:
            return self.valore if self.chiave == chiave else None


def aspetta(thread, scadenza):
    if thread:
        thread.join(max(0.0, scadenza - time.time()))


# --- /proc e /sys: letti a ogni richiesta (qualche millisecondo) ---

def leggi_file(percorso):
    try:
        with open(percorso) as f:
            return f.read()
    except OSError:
        return ''


def campioni_cpu():
    for riga in leggi_file('/proc/stat').splitlines():
        if riga.startswith('cpu '):
            v = [int(x) for x in riga.split()[1:9]]
            return sum(v), v[3] + v[4]  # totale, inattivo (idle + iowait), come sistema.js
    return None


def contatori_rete():
    # Byte ricevuti e trasmessi per interfaccia, da /proc/net/dev
    out = {}
    for riga in leggi_file('/proc/net/dev').splitlines()[2:]:
        nome, _, valori = riga.partition(':')
        v = valori.split()
        if len(v) >= 9:
            out[nome.strip()] = (int(v[0]), int(v[8]))
    return out


def campione():
    return {'t': time.time(), 'cpu': campioni_cpu(), 'rete': contatori_rete()}


misure_stato = {'campione': None, 'risultato': None, 't_ris': 0.0}
blocco_misure = threading.Lock()


def misure():
    # CPU (%) e velocità di rete (bit/s per interfaccia) col delta rispetto alla lettura precedente.
    # Richieste a meno di 1 s (due pannelli, la pagina) riusano l'ultimo risultato; senza una lettura
    # recente si misura su 0,15 s.
    with blocco_misure:
        s = misure_stato
        if s['risultato'] and time.time() - s['t_ris'] < 1.0:
            return s['risultato']
        prima = s['campione']
        if not prima or time.time() - prima['t'] > 60:
            prima = campione()
            time.sleep(0.15)
        dopo = campione()
        dt = dopo['t'] - prima['t']
        cpu = None
        if prima['cpu'] and dopo['cpu'] and dopo['cpu'][0] > prima['cpu'][0]:
            uso = 1 - (dopo['cpu'][1] - prima['cpu'][1]) / (dopo['cpu'][0] - prima['cpu'][0])
            cpu = max(0, min(100, round(uso * 100)))
        elif s['risultato']:
            cpu = s['risultato']['cpu']
        velocita = {}
        for nome, (rx, tx) in dopo['rete'].items():
            p = prima['rete'].get(nome)
            if p and dt > 0 and rx >= p[0] and tx >= p[1]:
                velocita[nome] = (round((rx - p[0]) * 8 / dt), round((tx - p[1]) * 8 / dt))
        s['campione'] = dopo
        s['risultato'], s['t_ris'] = {'cpu': cpu, 'velocita': velocita}, time.time()
        return s['risultato']


def uso_cpu():
    return misure()['cpu']


def ip_di(interfaccia):
    try:
        import fcntl
        import socket
        import struct
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            dati = fcntl.ioctl(s.fileno(), 0x8915, struct.pack('256s', interfaccia[:15].encode()))  # SIOCGIFADDR
            return socket.inet_ntoa(dati[20:24])
        finally:
            s.close()
    except (ImportError, OSError):
        return None


def qualita_wifi(dbm):
    # Come qualitaWifi() di app/js/sistema.js
    if dbm >= -55:
        return 'ottimo'
    if dbm >= -67:
        return 'buono'
    if dbm >= -75:
        return 'discreto'
    return 'debole'


def segnale_wifi(interfaccia):
    # /proc/net/wireless: livello in dBm; sulla G6 è scritto senza segno ("217." = -39 dBm)
    for riga in leggi_file('/proc/net/wireless').splitlines()[2:]:
        nome, _, valori = riga.partition(':')
        if nome.strip() == interfaccia:
            try:
                livello = float(valori.split()[2].rstrip('.'))
            except (IndexError, ValueError):
                return None
            if livello > 0:
                livello -= 256
            return qualita_wifi(livello) if livello < 0 else None
    return None


def rete():
    # Interfaccia principale come in app/js/sistema.js: la prima cablata/Wi-Fi con un indirizzo IP
    m = misure()
    candidate = [(n, ip_di(n)) for n in contatori_rete() if n != 'lo']
    candidate = [c for c in candidate if c[1]]
    scelta = next((c for c in candidate if re.match(r'^(eth|wlan)', c[0])), candidate[0] if candidate else None)
    if not scelta:
        return None
    nome, ip = scelta
    wifi = nome.startswith('wlan')
    velocita = m['velocita'].get(nome) or (None, None)
    return {'connessione': 'Wi-Fi' if wifi else 'Cablata', 'segnale': segnale_wifi(nome) if wifi else None,
            'ip': ip, 'download': velocita[0], 'upload': velocita[1]}


def memoria():
    v = dict(re.findall(r'^(\w+):\s+(\d+)', leggi_file('/proc/meminfo'), re.M))
    if 'MemTotal' not in v or 'MemAvailable' not in v:
        return None
    totale = int(v['MemTotal'])
    return {'usata': totale - int(v['MemAvailable']), 'totale': totale}


def disco():
    try:
        s = os.statvfs('/media/internal')
    except OSError:
        return None
    # Come df -Pk: totale = blocchi, usato = blocchi - liberi (anche quelli riservati)
    return {'usato': (s.f_blocks - s.f_bfree) * s.f_frsize // 1024, 'totale': s.f_blocks * s.f_frsize // 1024}


def temperatura():
    # La G6 (webOS 11.2) non espone sensori: di solito null
    for percorso in sorted(glob.glob('/sys/class/thermal/thermal_zone*/temp')) + \
            sorted(glob.glob('/sys/class/hwmon/hwmon*/temp*_input')):
        try:
            t = int(leggi_file(percorso).strip())
        except ValueError:
            continue
        t = t / 1000 if t > 1000 else t
        if 0 < t < 150:
            return round(t)
    return None


def uptime():
    try:
        return int(float(leggi_file('/proc/uptime').split()[0]))
    except (IndexError, ValueError):
        return None


def carico():
    try:
        return round(float(leggi_file('/proc/loadavg').split()[0]), 2)
    except (IndexError, ValueError):
        return None


# --- App davanti e sorgente ---

def _app_davanti(_):
    return luna_dati('luna://com.webos.applicationManager/getForegroundAppInfo').get('appId') or None


def _titoli_app(_):
    titoli = {}
    for p in luna_dati('luna://com.webos.applicationManager/listLaunchPoints', attesa=5).get('launchPoints', []):
        if p.get('id') and p.get('title'):
            # Il punto di avvio principale di un'app ha launchPointId = id + "_default"
            if p['id'] not in titoli or p.get('launchPointId') == p['id'] + '_default':
                titoli[p['id']] = p['title']
    return titoli


def _info_app(app_id):
    # Per le app di sistema che non sono nell'elenco dei punti di avvio (es. il Media Player)
    return (luna_dati('luna://com.webos.applicationManager/getAppInfo', {'id': app_id}).get('appInfo') or {}).get('title')


memo_davanti = Memo(_app_davanti, 2)
memo_titoli = Memo(_titoli_app, 600)
memo_info = Memo(_info_app, 3600)


def nome_ingresso(app_id):
    # Come nomeIngresso() di app/js/barra.js, solo per gli ingressi (regola INGRESSO)
    if app_id == LIVETV:
        return 'Live TV'
    m = re.match(r'^com\.webos\.app\.hdmi(\d+)$', app_id)
    if m:
        return 'HDMI ' + m.group(1)
    m = re.match(r'^com\.webos\.app\.(?:externalinput\.)?(\w+)$', app_id)
    if m and re.match(r'^com\.webos\.app\.(externalinput\.\w+|comp\w*|av\d*)$', app_id):
        return m.group(1)[:1].upper() + m.group(1)[1:]
    return None


# --- Luna con cache ---

def _volume(_):
    try:
        s = luna_dati('luna://com.webos.service.audio/master/getVolume').get('volumeStatus') or {}
        if 'volume' in s:
            return {'volume': s.get('volume'), 'muto': s.get('muteStatus')}
    except Exception:
        pass
    r = luna_dati('luna://com.webos.audio/getVolume')  # webOS più vecchi
    return {'volume': r.get('volume'), 'muto': r.get('muted', r.get('mute'))}


def _immagine(_):
    # Senza "dimension" la TV risponde per la sorgente e la gamma dinamica (SDR/HDR/Dolby) di adesso
    r = luna_dati('luna://com.webos.settingsservice/getSystemSettings', {'category': 'picture', 'keys': ['pictureMode']})
    m = (r.get('settings') or {}).get('pictureMode')
    return (MODALITA_IMMAGINE.get(m) or m[:1].upper() + m[1:]) if m else None


USCITE_AUDIO = {
    'tv_speaker': 'Altoparlanti TV', 'tv_speakerbar': 'Altoparlanti TV', 'builtin_soundbar': 'Altoparlanti TV',
    'external_optical': 'Ottico', 'bt_soundbar': 'Bluetooth', 'bt_audio': 'Bluetooth', 'bt_atmos': 'Bluetooth',
    'bt_soundengine': 'Bluetooth', 'bt_tv_atmos': 'Bluetooth', 'headphone': 'Cuffie', 'lineout': 'Uscita cuffie/linea',
    'mobile_phone': 'Telefono', 'lgSoundSync': 'LG Sound Sync', 'wisa_speaker': 'Altoparlanti WiSA',
    'usb_speaker': 'Altoparlanti USB', 'wow_cast': 'WOWCAST', 'tv_external_speaker': 'Altoparlanti TV + ottico',
    'tv_speaker_headphone': 'Altoparlanti TV + cuffie', 'tv_speakerbar_headphone': 'Altoparlanti TV + cuffie',
    'tv_speaker_bluetooth': 'Altoparlanti TV + Bluetooth', 'tv_speaker_bt_surround': 'Altoparlanti TV + Bluetooth',
    'tv_speaker_bt_tv_atmos': 'Altoparlanti TV + Bluetooth', 'tv_speaker_external_arc': 'Altoparlanti TV + soundbar',
    'tv_speaker_optical_arc': 'Altoparlanti TV + soundbar', 'tv_speaker_wow_cast': 'Altoparlanti TV + WOWCAST',
}
# Come nel menu Audio della TV (con la soundbar in sincronia valgono le sue modalità)
MODALITA_AUDIO = {
    'aiSoundPlus': 'AI Sound Pro', 'aiSound': 'AI Sound', 'aiSound_soundbar': 'AI Sound Pro', 'standard': 'Standard',
    'movie': 'Cinema', 'news': 'Voce chiara', 'newsHigh': 'Voce chiara', 'voiceEnhance': 'Voce chiara',
    'sports': 'Sport', 'music': 'Musica', 'game': 'Gioco', 'game_rts': 'Gioco', 'game_fps': 'Gioco',
    'bassBlast': 'Bass Blast', 'bassBoost': 'Bassi potenziati', 'dtsVirtualX': 'DTS Virtual:X',
    'personalized': 'Personalizzata', 'custom': 'Personalizzata', 'customEq': 'Personalizzata',
}


def leggibile(valore):
    # "external_arc_bno" → "External arc bno", "someMode" → "Some mode": per i valori che non conosciamo
    testo = re.sub(r'(?<=[a-z])(?=[A-Z])', ' ', valore).replace('_', ' ').strip().lower()
    return testo[:1].upper() + testo[1:]


def _audio(_):
    # Uscita e modalità della sorgente di adesso (senza "dimension", come l'immagine)
    r = luna_dati('luna://com.webos.settingsservice/getSystemSettings',
                  {'category': 'sound', 'keys': ['soundOutput', 'soundMode', 'eArcSupport']})
    s = r.get('settings') or {}
    uscita = re.sub(r'_(bno|sound_alive|sound_mode_sync|harmony)$', '', s.get('soundOutput') or '')
    if uscita == 'external_arc':
        nome_uscita = 'Soundbar (eARC)' if s.get('eArcSupport') == 'on' else 'Soundbar (ARC)'
    else:
        nome_uscita = USCITE_AUDIO.get(uscita) or (leggibile(uscita) if uscita else None)
    modo = s.get('soundMode') or ''
    return {'uscita': nome_uscita, 'modalita': MODALITA_AUDIO.get(modo) or (leggibile(modo) if modo else None)}


def _info_tv(_):
    # Non cambiano: letti all'avvio del server (e riletti dopo 60 s se qualcosa manca)
    try:
        with open('/var/run/nyx/os_info.json') as f:
            os_info = json.load(f)
    except (OSError, ValueError):
        os_info = {}
    try:
        r = luna_dati('luna://com.webos.service.tv.systemproperty/getSystemInfo',
                      {'keys': ['modelName', 'firmwareVersion', 'sdkVersion']})
    except Exception:
        r = {}
    return {
        'modello': (r.get('modelName') or '').split('.')[0] or None,  # "OLED55XXXXX.ABCDEFG" → "OLED55XXXXX"
        'webos': os_info.get('webos_release') or r.get('sdkVersion') or None,
        'firmware': r.get('firmwareVersion') or os_info.get('webos_manufacturing_version') or None,
        'dashboard': versione() or None,
    }


def _canale(_):
    r = luna_dati('luna://com.webos.service.apiadapter/tv/getCurrentChannel')
    c = r.get('channel') or r
    return c if c.get('channelId') or c.get('channelName') else None


def _orario_epg(testo):
    # "2026,11,04,20,30,00" o "2026/11/04 20:30:00": ora locale della TV
    n = [int(x) for x in re.split(r'\D+', str(testo or '')) if x]
    return datetime(*n[:6]) if len(n) >= 5 else None


def adesso_locale():
    # Python sulla TV potrebbe non conoscere il fuso: si usa quello di Luna (in cache), altrimenti quello di sistema
    offset = memo_fuso.leggi()
    if offset is None:
        memo_fuso.aggiorna()
        return datetime.now()
    return EPOCA + timedelta(seconds=time.time() + offset)


def _fuso(_):
    r = luna_dati('luna://com.webos.service.systemservice/time/getSystemTime')
    l, utc = r.get('localtime') or {}, r.get('utc')
    if not utc or 'year' not in l:
        return None
    locale = datetime(l['year'], l['month'], l['day'], l['hour'], l['minute'], l.get('second', 0))
    secondi = (locale - (EPOCA + timedelta(seconds=utc))).total_seconds()
    return round(secondi / 900) * 900  # i fusi orari sono multipli di 15 minuti


def _guida(segnale):
    # Come programmiDaEpgdb() di app/js/tv.js: palinsesto dal database EPG della TV, da 6 ore fa
    def cerca(da, dove):
        try:
            return luna_dati('luna://com.webos.epgdb/find', {'query': {'from': da, 'where': dove, 'limit': 30}},
                             attesa=5).get('results') or []
        except Exception:
            return []
    da = (adesso_locale() - timedelta(hours=6)).strftime('%Y,%m,%d,%H,%M,%S')
    lista = cerca('com.webos.programSCH:4', [{'prop': 'signalChannelId', 'op': '=', 'val': segnale},
                                            {'prop': 'localStartTime', 'op': '>=', 'val': da}])
    if not lista:
        lista = cerca('com.webos.programPF:4', [{'prop': 'signalChannelId', 'op': '=', 'val': segnale}])
    programmi = []
    for p in lista:
        nome = p.get('programName') or p.get('title')
        inizio = _orario_epg(p.get('localStartTime') or p.get('startTime'))
        fine = _orario_epg(p.get('localEndTime') or p.get('endTime'))
        if nome and inizio and fine:
            programmi.append((inizio, fine, nome))
    return sorted(programmi)


memo_volume = Memo(_volume, 2)
memo_immagine = Memo(_immagine, 10)
memo_audio = Memo(_audio, 10)
memo_info_tv = Memo(_info_tv, 24 * 3600, riprova=60)
memo_canale = Memo(_canale, 10)
memo_guida = Memo(_guida, 600)
memo_fuso = Memo(_fuso, 1800)


def segnale_canale(c):
    return c.get('signalChannelId') or '_'.join(str(c.get('channelId') or '').split('_')[-3:])


def canale_attuale(c, programmi):
    if not c:
        return None
    adesso = adesso_locale()
    in_corso = next((p for p in programmi or [] if p[0] <= adesso < p[1]), None)
    return {
        'numero': str(c.get('channelNumber') or c.get('number') or '') or None,
        'nome': c.get('channelName') or c.get('name') or None,
        'programma': in_corso[2] if in_corso else None,
        'inizio': in_corso[0].strftime('%H:%M') if in_corso else None,
        'fine': in_corso[1].strftime('%H:%M') if in_corso else None,
    }


# --- Film nel Media Player LG ---

def _pipeline(_):
    # Come film/traccia.py: la riproduzione del Media Player LG (DLNA via http, ma anche file da USB)
    lista = luna_dati('luna://com.webos.media/getActivePipelines')
    for p in lista if isinstance(lista, list) else []:
        if p.get('type') == 'media' and p.get('appId') == MEDIA_PLAYER and p.get('id'):
            return p
    return None


memo_pipeline = Memo(_pipeline, 3)


class Riproduzione:
    """Segue il video con com.webos.media/subscribe (come traccia.py): posizione ~ogni 200 ms, durata,
    pausa. L'abbonamento si chiude da solo se per 30 s nessuno chiede /api/sistema."""

    def __init__(self):
        self.lock = threading.Lock()
        self.id = self.proc = self.uri = self.ms = self.durata_ms = self.evento = None
        self.cambiato = self.t_evento = self.ultima_richiesta = 0.0

    def segui(self, pipeline):
        with self.lock:
            self.ultima_richiesta = time.time()
            if pipeline.get('id') == self.id and self.proc and self.proc.poll() is None:
                return
            self._chiudi()
            self.id, self.uri = pipeline.get('id'), str(pipeline.get('uri') or '')
            self.ms = self.durata_ms = None
            self.cambiato = time.time()  # finché non arrivano dati si considera in riproduzione
            self.evento, self.t_evento = None, 0.0
            self.proc = subprocess.Popen(['luna-send', '-i', 'luna://com.webos.media/subscribe',
                                          json.dumps({'mediaId': self.id})],
                                         stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            threading.Thread(target=self._leggi, args=(self.proc, self.id), daemon=True).start()
            threading.Thread(target=self._controlla, args=(self.proc,), daemon=True).start()

    def _chiudi(self):
        if self.proc and self.proc.poll() is None:
            self.proc.kill()
        self.proc = self.id = None

    def ferma(self):
        with self.lock:
            self._chiudi()

    def _leggi(self, proc, mio):
        for riga in proc.stdout:
            try:
                d = json.loads(riga.decode('utf-8', 'replace'))
            except ValueError:
                continue
            with self.lock:
                if self.id != mio:
                    break
                adesso = time.time()
                if isinstance(d.get('currentTime'), dict):
                    ms = int(d['currentTime'].get('currentTime') or 0)
                    if ms != self.ms:
                        self.ms, self.cambiato = ms, adesso
                if isinstance(d.get('sourceInfo'), dict):
                    durata = d['sourceInfo'].get('duration')
                    for prog in d['sourceInfo'].get('programInfo') or []:
                        durata = durata or (prog.get('duration') if isinstance(prog, dict) else None)
                    self.durata_ms = int(durata) if durata else self.durata_ms
                if 'paused' in d or 'endOfStream' in d:
                    self.evento, self.t_evento = 'pause', adesso
                elif 'playing' in d:
                    self.evento, self.t_evento = 'play', adesso
                    self.cambiato = adesso

    def _controlla(self, proc):
        while proc.poll() is None:
            time.sleep(5)
            with self.lock:
                if proc is self.proc and time.time() - self.ultima_richiesta > 30:
                    self._chiudi()

    def stato(self):
        with self.lock:
            if not self.id:
                return None
            adesso = time.time()
            if self.evento == 'pause' and self.t_evento >= self.cambiato:
                stato = 'pause'
            else:
                # In riproduzione la posizione avanza di continuo; ferma da più di 2,5 s = in pausa
                stato = 'play' if adesso - self.cambiato < 2.5 else 'pause'
            return {'uri': self.uri, 'ms': self.ms, 'durata_ms': self.durata_ms, 'stato': stato}


riproduzione = Riproduzione()
indice_dlna = {'titoli': {}, 'durate': {}, 'quando': 0.0, 'in_corso': False}
blocco_dlna = threading.Lock()


def _carica_indice_dlna():
    try:
        try:
            with open(os.path.join(CARTELLA, 'config.json')) as f:
                url = (json.load(f).get('dlna') or {}).get('url') or ''
        except (OSError, ValueError, AttributeError):
            url = ''
        out = subprocess.run(['python3', os.path.join(CARTELLA, 'dlna.py'), 'indice'] + ([url] if url else []),
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             timeout=120).stdout
        video = json.loads(out.decode('utf-8', 'replace')).get('video') or []
        titoli = {v['url']: v.get('titolo') for v in video if v.get('url') and v.get('titolo')}
        durate = {v['url']: v.get('durata') for v in video if v.get('url') and v.get('durata')}
        with blocco_dlna:
            if titoli:
                indice_dlna['titoli'], indice_dlna['durate'] = titoli, durate
    except Exception:
        pass
    finally:
        with blocco_dlna:
            indice_dlna['quando'], indice_dlna['in_corso'] = time.time(), False


def dati_dlna(uri):
    # Titolo e durata dall'indice del server DLNA; se il video non c'è, l'indice si rifà (al massimo ogni 5 min)
    with blocco_dlna:
        if uri in indice_dlna['titoli']:
            return indice_dlna['titoli'][uri], indice_dlna['durate'].get(uri)
        if uri.startswith('http') and not indice_dlna['in_corso'] and time.time() - indice_dlna['quando'] > 300:
            indice_dlna['in_corso'] = True
            threading.Thread(target=_carica_indice_dlna, daemon=True).start()
    return None, None


def titolo_da_uri(uri):
    # Nome del file (video da USB); i link DLNA spesso sono solo numeri ("MediaItems/123.mkv"): meglio null
    nome = unquote(urlparse(uri).path.rstrip('/').rsplit('/', 1)[-1])
    nome = re.sub(r'\.\w{2,4}$', '', nome).replace('_', ' ').replace('.', ' ').strip()
    return nome if re.search(r'[^\W\d]', nome) else None


def media_attuale(pipeline):
    if not pipeline:
        riproduzione.ferma()
        return None
    riproduzione.segui(pipeline)
    s = riproduzione.stato()
    if not s:
        return None
    uri = s['uri']
    titolo, durata = dati_dlna(uri)
    posizione = s['ms'] // 1000 if s['ms'] is not None else None
    durata = s['durata_ms'] // 1000 if s['durata_ms'] else durata
    if posizione is None or not durata:
        # Appena abbonati: l'ultimo punto salvato da traccia.py (ogni 10 s)
        try:
            with open(FILE_POSIZIONI, encoding='utf-8') as f:
                voce = json.load(f).get(uri) or {}
        except (OSError, ValueError, AttributeError):
            voce = {}
        posizione = posizione if posizione is not None else voce.get('pos')
        durata = durata or voce.get('durata')
    return {'titolo': titolo or titolo_da_uri(uri), 'posizione': posizione, 'durata': durata or None, 'stato': s['stato']}


# --- Risposta ---

def stato_sistema():
    scadenza = time.time() + ATTESA_MAX
    attesi = []

    davanti = leggi_file(FILE_PRIMO_PIANO).strip() or None
    if not davanti:  # servizio.sh non lo ha (ancora) scritto: si chiede a Luna
        aspetta(memo_davanti.aggiorna(), scadenza)
        davanti = memo_davanti.leggi()

    # Avvio dei ricalcoli Luna in parallelo; si aspetta solo chi non ha ancora nessun valore
    def avvia(memo, chiave=None):
        t = memo.aggiorna(chiave)
        if t and memo.leggi(chiave) is None:
            attesi.append(t)

    avvia(memo_titoli)
    avvia(memo_volume)
    avvia(memo_immagine, davanti)
    avvia(memo_audio, davanti)
    avvia(memo_info_tv)
    if davanti == LIVETV:
        avvia(memo_canale)
        avvia(memo_fuso)
    if davanti == MEDIA_PLAYER:
        avvia(memo_pipeline)

    risposta = {'cpu': uso_cpu(), 'ram': memoria(), 'disco': disco(), 'temp': temperatura(),
                'uptime': uptime(), 'carico': carico()}
    for t in attesi:
        aspetta(t, scadenza)

    nome = None
    if davanti:
        nome = (memo_titoli.leggi() or {}).get(davanti)
        if not nome and memo_titoli.leggi() is not None:
            # Non è tra i punti di avvio (app di sistema o installata da poco): getAppInfo, in cache per app
            avvia(memo_info, davanti)
            for t in attesi:
                aspetta(t, scadenza)
            nome = memo_info.leggi(davanti)
        nome = nome or nome_ingresso(davanti) or davanti
    risposta['app'] = {'id': davanti, 'nome': nome} if davanti else None
    risposta['sorgente'] = (nome_ingresso(davanti) or nome) if davanti else None

    canale = None
    if davanti == LIVETV:
        c = memo_canale.leggi()
        if c:
            segnale = segnale_canale(c)
            if segnale:
                avvia(memo_guida, segnale)
                for t in attesi:
                    aspetta(t, scadenza)
            canale = canale_attuale(c, memo_guida.leggi(segnale) if segnale else None)
    risposta['canale'] = canale
    risposta['media'] = media_attuale(memo_pipeline.leggi() if davanti == MEDIA_PLAYER else None)

    risposta['immagine'] = memo_immagine.leggi(davanti)
    volume = memo_volume.leggi() or {}
    risposta['volume'] = volume.get('volume') if isinstance(volume.get('volume'), int) else None
    risposta['muto'] = volume.get('muto') if isinstance(volume.get('muto'), bool) else None
    risposta['audio'] = memo_audio.leggi(davanti)
    risposta['info'] = memo_info_tv.leggi() or {'modello': None, 'webos': None, 'firmware': None, 'dashboard': versione() or None}
    risposta['rete'] = rete()
    return risposta


# ---------- Server HTTP ----------

class Gestore(BaseHTTPRequestHandler):
    server_version = 'DashboardConfigura'

    def log_message(self, *argomenti):
        pass

    def rispondi(self, stato, corpo, tipo='application/json; charset=utf-8'):
        if not isinstance(corpo, bytes):
            corpo = json.dumps(corpo, ensure_ascii=False).encode('utf-8')
        self.send_response(stato)
        self.send_header('Content-Type', tipo)
        self.send_header('Content-Length', str(len(corpo)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(corpo)

    def do_GET(self):
        url = urlparse(self.path)
        try:
            if url.path in ('/', '/index.html'):
                with open(os.path.join(CARTELLA, 'configura.html'), 'rb') as f:
                    self.rispondi(200, f.read(), 'text/html; charset=utf-8')
            elif url.path == '/api/stato':
                self.rispondi(200, {
                    'versione': versione(),
                    'impostazioni': leggi_impostazioni(),
                    'opzioni': leggi_opzioni(),
                    'app': elenco_app(),
                    'ingressi': elenco_ingressi(),
                })
            elif url.path == '/api/sistema':
                self.rispondi(200, stato_sistema())
            elif url.path == '/icona':
                chiave = (parse_qs(url.query).get('k') or [''])[0]
                if not icone:
                    elenco_app()
                percorso = icone.get(chiave)
                if not percorso:
                    self.rispondi(404, {'errore': 'icona non trovata'})
                    return
                with open(percorso, 'rb') as f:
                    estensione = percorso.rsplit('.', 1)[-1].lower()
                    self.rispondi(200, f.read(), MIME.get(estensione, 'application/octet-stream'))
            else:
                self.rispondi(404, {'errore': 'pagina non trovata'})
        except Exception as e:
            self.rispondi(500, {'errore': str(e)})

    def do_POST(self):
        try:
            lunghezza = int(self.headers.get('Content-Length') or 0)
            if lunghezza > 65536:
                raise ErroreRichiesta('richiesta troppo grande')
            try:
                dati = json.loads(self.rfile.read(lunghezza) or b'{}')
            except ValueError:
                raise ErroreRichiesta('JSON non valido')
            if self.path == '/api/impostazioni':
                self.rispondi(200, {'impostazioni': aggiorna_impostazioni(dati)})
            elif self.path == '/api/opzioni':
                self.rispondi(200, {'opzioni': aggiorna_opzioni(dati)})
            elif self.path == '/api/wol':
                self.rispondi(200, accendi(dati))
            elif self.path == '/api/spegni':
                self.rispondi(200, {'spenta': True})
                spegni_pagina()
            else:
                self.rispondi(404, {'errore': 'indirizzo non trovato'})
        except (ErroreRichiesta, ValueError) as e:
            self.rispondi(400, {'errore': str(e)})
        except Exception as e:
            self.rispondi(500, {'errore': str(e)})


if __name__ == '__main__':
    memo_info_tv.aggiorna()  # modello, versioni: una volta all'avvio
    ThreadingHTTPServer.daemon_threads = True
    ThreadingHTTPServer(('', PORTA), Gestore).serve_forever()
