#!/usr/bin/env python3
# Elenco dei video di un server DLNA/UPnP per la card "Film" della dashboard.
#
#   python3 dlna.py sfoglia [ID_CARTELLA] [URL_SERVER]
#   python3 dlna.py indice [URL_SERVER]      (tutti i video, con le cartelle in cui stanno: app Film)
#   python3 dlna.py immagini [URL_SERVER]    (le foto della cartella Foto: sfondi della dashboard)
#
# Senza ID parte dalla cartella dei video e scende da sola finché c'è una sola sottocartella.
# Senza URL_SERVER cerca il server in rete (SSDP) e lo ricorda in /tmp.
# Stampa un JSON: { server, id, titolo, voci: [{ tipo: "cartella"|"video", ... }] }

import html
import json
import re
import socket
import sys
import time
import urllib.parse
import urllib.request

CACHE = '/tmp/dashboard-dlna-server'
ST = 'urn:schemas-upnp-org:device:MediaServer:1'
CD = 'urn:schemas-upnp-org:service:ContentDirectory:1'


def scopri():
    msg = ('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\n'
           'MX: 2\r\nST: %s\r\n\r\n' % ST).encode()
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
    s.settimeout(3)
    s.sendto(msg, ('239.255.255.250', 1900))
    fine = time.time() + 3
    while time.time() < fine:
        try:
            dati, _ = s.recvfrom(65535)
        except socket.timeout:
            break
        m = re.search(r'(?im)^location:\s*(\S+)', dati.decode('utf-8', 'replace'))
        if m:
            return m.group(1)
    return None


def descrizione(location):
    x = urllib.request.urlopen(location, timeout=5).read().decode('utf-8', 'replace')
    nome = re.search(r'<friendlyName>(.*?)</friendlyName>', x, re.S)
    controllo = None
    for blocco in re.findall(r'<service>(.*?)</service>', x, re.S):
        if 'ContentDirectory' in blocco:
            c = re.search(r'<controlURL>(.*?)</controlURL>', blocco, re.S)
            if c:
                controllo = urllib.parse.urljoin(location, c.group(1).strip())
    if not controllo:
        raise RuntimeError('il server non ha ContentDirectory')
    udn = re.search(r'<UDN>(.*?)</UDN>', x, re.S)
    return {
        'nome': html.unescape(nome.group(1).strip()) if nome else 'DLNA',
        'location': location,
        'controllo': controllo,
        'udn': udn.group(1).strip() if udn else '',
    }


def server(url):
    candidati = []
    if url:
        candidati.append(url if url.endswith('.xml') else url.rstrip('/') + '/rootDesc.xml')
    else:
        try:
            candidati.append(open(CACHE).read().strip())
        except OSError:
            pass
    for loc in candidati:
        try:
            return descrizione(loc)
        except Exception:
            pass
    if url:
        raise RuntimeError('server DLNA non raggiungibile: ' + url)
    loc = scopri()
    if not loc:
        raise RuntimeError('nessun server DLNA trovato in rete')
    d = descrizione(loc)
    try:
        open(CACHE, 'w').write(loc)
    except OSError:
        pass
    return d


def browse(srv, oid, inizio, quanti):
    corpo = ('<?xml version="1.0" encoding="utf-8"?>'
             '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
             's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
             '<u:Browse xmlns:u="%s"><ObjectID>%s</ObjectID>'
             '<BrowseFlag>BrowseDirectChildren</BrowseFlag><Filter>*</Filter>'
             '<StartingIndex>%d</StartingIndex><RequestedCount>%d</RequestedCount>'
             '<SortCriteria></SortCriteria></u:Browse></s:Body></s:Envelope>'
             ) % (CD, html.escape(oid), inizio, quanti)
    req = urllib.request.Request(srv['controllo'], corpo.encode('utf-8'), {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPACTION': '"%s#Browse"' % CD,
    })
    r = urllib.request.urlopen(req, timeout=10).read().decode('utf-8', 'replace')
    m = re.search(r'<Result>(.*?)</Result>', r, re.S)
    totale = re.search(r'<TotalMatches>(\d+)', r)
    restituiti = re.search(r'<NumberReturned>(\d+)', r)
    return (html.unescape(m.group(1)) if m else '',
            int(totale.group(1)) if totale else 0,
            int(restituiti.group(1)) if restituiti else 0)


def attributo(testo, nome):
    m = re.search(r'\b%s="([^"]*)"' % nome, testo)
    return html.unescape(m.group(1)) if m else ''


def tag(testo, nome):
    m = re.search(r'<%s[^>]*>(.*?)</%s>' % (nome, nome), testo, re.S)
    return html.unescape(m.group(1).strip()) if m else ''


def secondi(durata):
    m = re.match(r'(\d+):(\d+):(\d+)', durata or '')
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3)) if m else 0


def figli(srv, oid):
    cartelle, video = [], []
    inizio = 0
    while True:
        risultato, totale, n = browse(srv, oid, inizio, 200)
        for c in re.findall(r'<container\b.*?</container>', risultato, re.S):
            cartelle.append({'tipo': 'cartella', 'id': attributo(c, 'id'), 'titolo': tag(c, 'dc:title'),
                             'figli': int(attributo(c, 'childCount') or 0)})
        for it in re.findall(r'<item\b.*?</item>', risultato, re.S):
            classe = tag(it, 'upnp:class')
            if classe and 'videoItem' not in classe:
                continue
            res = re.search(r'<res\b([^>]*)>(.*?)</res>', it, re.S)
            if not res:
                continue
            a = res.group(1)
            info = attributo(a, 'protocolInfo')
            mime = info.split(':')[2] if info.count(':') >= 3 else ''
            if mime and not mime.startswith('video/'):
                continue
            miniatura = tag(it, 'upnp:albumArtURI')
            video.append({
                'tipo': 'video',
                'id': attributo(it, 'id'),
                'titolo': tag(it, 'dc:title'),
                'url': html.unescape(res.group(2).strip()),
                'protocolInfo': info,
                'mime': mime,
                'dimensione': int(attributo(a, 'size') or 0),
                'durata': secondi(attributo(a, 'duration')),
                'risoluzione': attributo(a, 'resolution'),
                'data': tag(it, 'dc:date'),
                'miniatura': miniatura,
            })
        inizio += n
        if n == 0 or inizio >= totale or inizio >= 2000:
            break
    chiave = lambda v: v['titolo'].lower()
    return sorted(cartelle, key=chiave) + sorted(video, key=chiave)


def sfoglia(oid, url):
    srv = server(url)
    titolo = srv['nome']
    voci = figli(srv, oid or '0')
    if not oid:
        # Dalla radice: cartella dei video, poi giù finché c'è una sola sottocartella
        video = [v for v in voci if v['tipo'] == 'cartella' and re.match(r'(?i)vid', v['titolo'])]
        if video:
            oid, titolo, voci = video[0]['id'], video[0]['titolo'], figli(srv, video[0]['id'])
        for _ in range(6):
            if len(voci) == 1 and voci[0]['tipo'] == 'cartella':
                oid, titolo, voci = voci[0]['id'], voci[0]['titolo'], figli(srv, voci[0]['id'])
            else:
                break
    return {'server': {'nome': srv['nome'], 'udn': srv['udn']}, 'id': oid or '0', 'titolo': titolo, 'voci': voci}


def indice(url):
    # Parte dalla stessa cartella della card Film e scende in tutte le sottocartelle
    radice = sfoglia('', url)
    srv = server(url)
    video = []

    def visita(voci, cartelle, profondita):
        for v in voci:
            if v['tipo'] == 'video':
                v['cartelle'] = cartelle
                video.append(v)
            elif profondita < 6:
                visita(figli(srv, v['id']), cartelle + [v['titolo']], profondita + 1)

    visita(radice['voci'], [], 0)
    return {'server': radice['server'], 'titolo': radice['titolo'], 'video': video}


def risoluzione(testo):
    m = re.match(r'(\d+)x(\d+)', testo or '')
    return (int(m.group(1)), int(m.group(2))) if m else (0, 0)


def immagini(url, massimo=500):
    # Foto per gli sfondi: cartella "Foto" (o Immagini, Pictures, Photos) della radice e tutte le sottocartelle.
    # Di ogni foto sceglie la versione più piccola larga almeno 1280 px (il server spesso ne offre più d'una).
    srv = server(url)
    radice, _, _ = browse(srv, '0', 0, 50)
    cartelle = [attributo(c, 'id') for c in re.findall(r'<container\b.*?</container>', radice, re.S)
                if re.match(r'(?i)(foto|immagini|pictures?|photos?|images?)\b', tag(c, 'dc:title'))]
    foto = []

    def visita(oid, profondita):
        inizio = 0
        while len(foto) < massimo:
            risultato, totale, n = browse(srv, oid, inizio, 200)
            for it in re.findall(r'<item\b.*?</item>', risultato, re.S):
                if 'imageItem' not in tag(it, 'upnp:class'):
                    continue
                versioni = []
                for a, indirizzo in re.findall(r'<res\b([^>]*)>(.*?)</res>', it, re.S):
                    w, h = risoluzione(attributo(a, 'resolution'))
                    versioni.append((w, h, html.unescape(indirizzo.strip())))
                if not versioni:
                    continue
                grandi = sorted(v for v in versioni if v[0] >= 1280)
                w, h, indirizzo = grandi[0] if grandi else max(versioni)
                foto.append({'titolo': tag(it, 'dc:title'), 'url': indirizzo, 'larghezza': w, 'altezza': h,
                             'data': tag(it, 'dc:date')})
            if profondita < 6:
                for c in re.findall(r'<container\b.*?</container>', risultato, re.S):
                    visita(attributo(c, 'id'), profondita + 1)
            inizio += n
            if n == 0 or inizio >= totale or inizio >= 2000:
                break

    for oid in cartelle:
        visita(oid, 0)
    return {'server': {'nome': srv['nome'], 'udn': srv['udn']}, 'foto': foto[:massimo]}


def main():
    comando = sys.argv[1] if len(sys.argv) > 1 else ''
    if comando not in ('sfoglia', 'indice', 'immagini'):
        print('uso: dlna.py sfoglia [ID] [URL] | dlna.py indice [URL] | dlna.py immagini [URL]', file=sys.stderr)
        sys.exit(2)
    try:
        if comando == 'indice':
            out = indice(sys.argv[2] if len(sys.argv) > 2 else '')
        elif comando == 'immagini':
            out = immagini(sys.argv[2] if len(sys.argv) > 2 else '')
        else:
            out = sfoglia(sys.argv[2] if len(sys.argv) > 2 else '', sys.argv[3] if len(sys.argv) > 3 else '')
    except Exception as e:
        out = {'errore': str(e)}
    print(json.dumps(out, ensure_ascii=False))


if __name__ == '__main__':
    main()
