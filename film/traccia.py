#!/usr/bin/env python3
# Segue il Media Player LG mentre riproduce un video DLNA e salva dove sei arrivato,
# per "Continua a guardare" e il segno "visto" dell'app Film. Gira come root, in background.
#
#   python3 traccia.py [URL SECONDI]
#
# Con URL e SECONDI, appena quel video parte lo porta al punto indicato: SECONDI > 0 per riprendere,
# 0 per ripartire dall'inizio (il Media Player LG ricorda da solo dove ci si era fermati e ripartirebbe da lì).
# Esce da solo quando il Media Player non riproduce più nulla.

import json
import os
import signal
import subprocess
import sys
import threading
import time

FILE = '/var/lib/webosbrew/dashboard/film-posizioni.json'
PID = '/tmp/film-traccia.pid'
PLAYER = 'com.webos.app.mediadiscovery'
FINE_QUASI = 0.95  # oltre questa frazione della durata il video conta come visto


def luna(uri, params):
    try:
        r = subprocess.run(['luna-send', '-n', '1', '-w', '4000', uri, json.dumps(params)],
                           stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10)
        return json.loads(r.stdout.decode('utf-8', 'replace') or 'null')
    except Exception:
        return None


def pipeline():
    lista = luna('luna://com.webos.media/getActivePipelines', {})
    if not isinstance(lista, list):
        return None
    for p in lista:
        if p.get('type') == 'media' and p.get('appId') == PLAYER and str(p.get('uri', '')).startswith('http'):
            return p
    return None


def carica():
    try:
        with open(FILE, encoding='utf-8') as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def salva(stato):
    if not stato['uri'] or stato['ms'] <= 0:
        return
    tutte = carica()
    voce = tutte.get(stato['uri'], {})
    voce['pos'] = round(stato['ms'] / 1000)
    voce['agg'] = int(time.time())
    if stato['durata']:
        voce['durata'] = round(stato['durata'] / 1000)
    if stato['fine'] or (stato['durata'] and stato['ms'] >= FINE_QUASI * stato['durata']):
        voce['visto'] = True
        voce['pos'] = 0
    tutte[stato['uri']] = voce
    os.makedirs(os.path.dirname(FILE), exist_ok=True)
    tmp = FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(tutte, f, ensure_ascii=False)
    os.replace(tmp, FILE)


def durata_da(info):
    if not isinstance(info, dict):
        return 0
    if info.get('duration'):
        return int(info['duration'])
    for prog in info.get('programInfo') or []:
        if isinstance(prog, dict) and prog.get('duration'):
            return int(prog['duration'])
    return 0


def iscriviti(stato):
    # Eventi del media server: currentTime (ms) circa ogni 200 ms, sourceInfo con la durata, endOfStream
    proc = subprocess.Popen(['luna-send', '-i', 'luna://com.webos.media/subscribe', json.dumps({'mediaId': stato['id']})],
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    mio = stato['id']

    def leggi():
        for riga in proc.stdout:
            try:
                d = json.loads(riga.decode('utf-8', 'replace'))
            except Exception:
                continue
            if stato['id'] != mio:
                break
            if isinstance(d.get('currentTime'), dict):
                stato['ms'] = int(d['currentTime'].get('currentTime') or 0)
            if 'sourceInfo' in d:
                stato['durata'] = durata_da(d['sourceInfo']) or stato['durata']
            if 'endOfStream' in d:
                stato['fine'] = True

    threading.Thread(target=leggi, daemon=True).start()
    return proc


def main():
    # Una sola istanza: la nuova (con l'eventuale punto di ripresa) sostituisce la vecchia
    try:
        with open(PID) as f:
            vecchio = int(f.read().strip())
        if vecchio != os.getpid():
            os.kill(vecchio, signal.SIGTERM)
    except Exception:
        pass
    with open(PID, 'w') as f:
        f.write(str(os.getpid()))

    riprendi_url = sys.argv[1] if len(sys.argv) > 2 else ''
    riprendi_ms = int(float(sys.argv[2]) * 1000) if len(sys.argv) > 2 else 0
    # Il Media Player può applicare la sua ripresa poco dopo l'avvio: si controlla per qualche secondo
    riprendi_dal = 0       # quando è arrivato il primo tempo del video da posizionare
    riprendi_seek = 0      # ultimo seek inviato
    riprendi_tentativi = 0

    stato = {'id': None, 'uri': None, 'ms': 0, 'durata': 0, 'fine': False}
    proc = None
    inizio = ultimo_visto = time.time()
    ultimo_salvataggio = 0

    def termina(*_):
        salva(stato)
        if proc:
            proc.kill()
        sys.exit(0)
    signal.signal(signal.SIGTERM, termina)

    while True:
        p = pipeline()
        adesso = time.time()
        if p:
            ultimo_visto = adesso
            if p.get('id') != stato['id']:
                # Video nuovo (anche l'episodio successivo nella playlist): chiude il precedente
                salva(stato)
                if proc:
                    proc.kill()
                stato.update(id=p.get('id'), uri=p.get('uri'), ms=0, durata=0, fine=False)
                proc = iscriviti(stato)
            if riprendi_url and stato['uri'] == riprendi_url and stato['ms'] > 0:
                riprendi_dal = riprendi_dal or adesso
                if abs(stato['ms'] - riprendi_ms) > 8000 and adesso - riprendi_seek > 3 and riprendi_tentativi < 4:
                    luna('luna://com.webos.media/seek', {'mediaId': stato['id'], 'position': riprendi_ms})
                    riprendi_seek = adesso
                    riprendi_tentativi += 1
                if adesso - riprendi_dal > 12:
                    riprendi_url = ''
        elif adesso - ultimo_visto > 20 and adesso - inizio > 60:
            break
        if stato['uri'] and (adesso - ultimo_salvataggio >= 10 or stato['fine']):
            salva(stato)
            ultimo_salvataggio = adesso
            if stato['fine']:
                stato['ms'] = 0
                stato['fine'] = False
                stato['uri'] = None
        time.sleep(2)

    salva(stato)
    if proc:
        proc.kill()
    try:
        os.remove(PID)
    except OSError:
        pass


if __name__ == '__main__':
    main()
