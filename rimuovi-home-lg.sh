#!/bin/sh
# Rende la dashboard l'unica Home: toglie la Home LG dal sistema con la funzione di LG blockSystemApp
# (la Home LG resta nella memoria di sola lettura della TV, il sistema semplicemente non la carica più).
# Prima salva sulla TV un backup delle preferenze del gestore delle app (backup-home-lg).
#
# Per tornare indietro (anche senza PC):
#   - dashboard → Impostazioni → Home: Home LG (o "dashboard")
#   - app "Home LG" sulla TV
#   - ./ripristina-lg.sh dal PC
# Se la dashboard viene disinstallata, al riavvio successivo la Home LG torna da sola.
# Uso (da Git Bash):  ./rimuovi-home-lg.sh [ip-tv]

TV="${1:-192.168.1.50}"
SERVIZIO=/media/developer/apps/usr/palm/applications/it.casa.dashboard/servizio.sh

REMOTO=$(cat <<EOF
exec </dev/null
if [ ! -f $SERVIZIO ]; then echo "Dashboard non installata: lancia prima ./installa.sh"; exit 1; fi
sh $SERVIZIO rimuovi-home && sh $SERVIZIO opzioni | sed 's/^/  /'
EOF
)

OPZ=""; [ -f "$HOME/.ssh/id_dashboard_tv" ] && OPZ="-i $HOME/.ssh/id_dashboard_tv"
ssh $OPZ root@"$TV" "$REMOTO"
