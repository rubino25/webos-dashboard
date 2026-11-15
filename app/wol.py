#!/usr/bin/env python3
# Wake-on-LAN per la dashboard: invia il "pacchetto magico" che accende un PC (o altro) spento.
#
#   python3 wol.py AA:BB:CC:DD:EE:FF
#
# Accetta il MAC con ":" o "-" o senza separatori. Lo manda in broadcast su ogni rete della TV
# (e su 255.255.255.255), sulle porte 9 e 7, tre volte: un pacchetto UDP perso non si accorge nessuno.

import re
import socket
import subprocess
import sys
import time


def indirizzi_broadcast():
    indirizzi = ['255.255.255.255']
    try:
        out = subprocess.run(['ip', '-4', '-o', 'addr'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             universal_newlines=True, timeout=5).stdout
        for brd in re.findall(r'\bbrd (\d+\.\d+\.\d+\.\d+)', out):
            if brd not in indirizzi:
                indirizzi.append(brd)
    except Exception:
        pass
    return indirizzi


def main():
    if len(sys.argv) != 2:
        sys.exit('uso: wol.py MAC')
    mac = re.sub(r'[^0-9a-fA-F]', '', sys.argv[1])
    if len(mac) != 12:
        sys.exit('MAC non valido: ' + sys.argv[1])
    pacchetto = b'\xff' * 6 + bytes.fromhex(mac) * 16

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    inviati = []
    for giro in range(3):
        for brd in indirizzi_broadcast() if giro == 0 else inviati:
            for porta in (9, 7):
                try:
                    s.sendto(pacchetto, (brd, porta))
                    if giro == 0 and brd not in inviati:
                        inviati.append(brd)
                except OSError:
                    pass
        time.sleep(0.2)
    if not inviati:
        sys.exit('nessuna rete disponibile')
    print('ok ' + ' '.join(inviati))


if __name__ == '__main__':
    main()
