#!/usr/bin/env python3
# Pagina web di configurazione della dashboard, servita dalla TV:  http://<ip-tv>:8095
# La avvia servizio.sh (come root) insieme agli altri monitor; in attesa non usa CPU.
#
#   GET  /                  la pagina (configura.html)
#   GET  /api/stato         impostazioni, opzioni Home/salvaschermo, app installate, ingressi
#   GET  /icona?k=<chiave>  icona di un'app dell'elenco
#   POST /api/impostazioni  {campo: valore, ...}: solo i campi previsti, controllati uno per uno
#   POST /api/opzioni       {home, accensione, salvaschermoLg}: le passa a servizio.sh
#   POST /api/wol           accende il dispositivo impostato (wol.py)
#   POST /api/spegni        spegne questa pagina (si riaccende dalla TV: Impostazioni → Pagina web)
#
# Le impostazioni stanno in /var/lib/webosbrew/dashboard/impostazioni.json, lo stesso file della dashboard.
# Dopo ogni modifica, se la dashboard è davanti, viene "rilanciata" con {ricarica: true} e le rilegge.

import json
import os
import re
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

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
    ThreadingHTTPServer.daemon_threads = True
    ThreadingHTTPServer(('', PORTA), Gestore).serve_forever()
