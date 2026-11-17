#!/bin/sh
# Compila e installa (o aggiorna) sulla TV, tramite l'SSH root di Homebrew Channel:
#  - la dashboard (it.casa.dashboard)
#  - "Home LG" (it.casa.dashboard.homelg), che riporta in un attimo Home e salvaschermo a quelli LG
#  - "Film" (it.casa.dashboard.film), la libreria del server DLNA
# Le impostazioni (dashboard come Home, accensione, salvaschermo) restano come sono.
# Uso (da Git Bash):  ./installa.sh [ip-tv]
# Con SENZA_AVVIO=1 non porta la dashboard in primo piano (non interrompe quello che si sta guardando).
set -e

TV="${1:-192.168.1.50}"
DIR="$(cd "$(dirname "$0")" && pwd)"
ID="it.casa.dashboard"
ID_HOMELG="it.casa.dashboard.homelg"
ID_FILM="it.casa.dashboard.film"

versione() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$1"; }

python "$DIR/build.py"
IPK="${ID}_$(versione "$DIR/app/appinfo.json")_all.ipk"
IPK_HOMELG="${ID_HOMELG}_$(versione "$DIR/homelg/appinfo.json")_all.ipk"
IPK_FILM="${ID_FILM}_$(versione "$DIR/film/appinfo.json")_all.ipk"
BUILD="$(cat "$DIR/dist/build.txt")"
BUILD_HOMELG="$(cat "$DIR/dist/build-homelg.txt")"
BUILD_FILM="$(cat "$DIR/dist/build-film.txt")"

# I due pacchetti arrivano insieme sullo stdin (tar), i comandi come argomento:
# una sola connessione e, senza chiave, una sola richiesta di password
REMOTO=$(cat <<EOF
set -e
mkdir -p /tmp/dashboard-installa
tar xf - -C /tmp/dashboard-installa
# luna-send termina subito se lo stdin è un canale già chiuso: da qui in poi niente stdin
exec </dev/null

installa() {
  luna-send -n 1 luna://com.webos.appInstallService/dev/install "{\"id\":\"\$1\",\"ipkUrl\":\"/tmp/dashboard-installa/\$2\",\"subscribe\":false}" >/dev/null
  i=0
  while :; do
    for f in /media/developer/apps/usr/palm/applications/\$1/build.txt /media/cryptofs/apps/usr/palm/applications/\$1/build.txt; do
      [ "\$(cat \$f 2>/dev/null)" = "\$3" ] && { APPDIR=\$(dirname \$f); return 0; }
    done
    i=\$((i + 1))
    if [ \$i -gt 60 ]; then echo "Installazione di \$1 non completata entro 60 s"; exit 1; fi
    sleep 1
  done
}

echo "Installazione di Home LG..."
installa $ID_HOMELG $IPK_HOMELG $BUILD_HOMELG
echo "Installazione di Film..."
installa $ID_FILM $IPK_FILM $BUILD_FILM
echo "Installazione della dashboard..."
installa $ID $IPK $BUILD
rm -rf /tmp/dashboard-installa

# Residui della versione 1.0
if [ -f /tmp/dashboard-tracker.pid ]; then
  kill -- "-\$(cat /tmp/dashboard-tracker.pid)" 2>/dev/null || kill "\$(cat /tmp/dashboard-tracker.pid)" 2>/dev/null || true
  rm -f /tmp/dashboard-tracker.pid
fi
rm -f /var/lib/webosbrew/init.d/dashboard-recenti

# Servizio in background: avvio a ogni boot tramite gli hook di Homebrew Channel, e subito.
# L'hook (/var/lib/webosbrew/init.d/dashboard) lo scrive "servizio.sh start"; se l'app viene
# disinstallata, l'hook fa tornare la Home LG (se era stata rimossa) e nient'altro.
sh \$APPDIR/servizio.sh stop
sh \$APPDIR/servizio.sh start
[ "$SENZA_AVVIO" = 1 ] || luna-send -n 1 luna://com.webos.applicationManager/launch '{"id":"$ID"}' >/dev/null
echo "Installate. Impostazioni attuali:"
sh \$APPDIR/servizio.sh opzioni | sed 's/^/  /'
EOF
)

# Usa la chiave SSH dedicata se presente (revocabile con revoca-accesso.sh), altrimenti la password
OPZ=""; [ -f "$HOME/.ssh/id_dashboard_tv" ] && OPZ="-i $HOME/.ssh/id_dashboard_tv"
echo "Invio $IPK, $IPK_HOMELG e $IPK_FILM a root@$TV..."
tar cf - -C "$DIR/dist" "$IPK" "$IPK_HOMELG" "$IPK_FILM" | ssh $OPZ root@"$TV" "$REMOTO"
