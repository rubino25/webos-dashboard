#!/bin/sh
# Rende la dashboard quella predefinita: si apre col tasto Home e all'accensione della TV.
# Il salvaschermo resta com'è (LG o dashboard, come scelto nelle Impostazioni).
# Per tornare indietro: app "Home LG" sulla TV, ./ripristina-lg.sh, oppure Home due volte di seguito.
# Uso (da Git Bash):  ./attiva-dashboard.sh [ip-tv]

TV="${1:-192.168.1.50}"
SERVIZIO=/media/developer/apps/usr/palm/applications/it.casa.dashboard/servizio.sh

REMOTO=$(cat <<EOF
exec </dev/null
if [ ! -f $SERVIZIO ]; then echo "Dashboard non installata: lancia prima ./installa.sh"; exit 1; fi
SALVASCHERMO_LG=0; HOME_IDS=com.webos.app.home; SALVASCHERMO_IDS=com.webos.app.screensaver
[ -f /var/lib/webosbrew/dashboard/opzioni ] && . /var/lib/webosbrew/dashboard/opzioni
sh $SERVIZIO imposta 1 1 "\$SALVASCHERMO_LG" "\$HOME_IDS" "\$SALVASCHERMO_IDS"
sh $SERVIZIO start
echo "Dashboard predefinita:"
sh $SERVIZIO opzioni | sed 's/^/  /'
EOF
)

OPZ=""; [ -f "$HOME/.ssh/id_dashboard_tv" ] && OPZ="-i $HOME/.ssh/id_dashboard_tv"
ssh $OPZ root@"$TV" "$REMOTO"
