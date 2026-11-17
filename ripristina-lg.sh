#!/bin/sh
# Riporta subito Home, accensione e salvaschermo a quelli LG e apre la Home LG
# (anche se era stata rimossa con "Solo dashboard": la rimette).
# La dashboard resta installata: si riattiva con ./attiva-dashboard.sh o dalle sue Impostazioni.
# Uso (da Git Bash):  ./ripristina-lg.sh [ip-tv]

TV="${1:-192.168.1.50}"
DASHBOARD=/media/developer/apps/usr/palm/applications/it.casa.dashboard
DATI=/var/lib/webosbrew/dashboard

REMOTO=$(cat <<EOF
exec </dev/null
if [ -f $DASHBOARD/servizio.sh ]; then
  sh $DASHBOARD/servizio.sh ripristina
else
  mkdir -p $DATI && printf 'HOME_DASHBOARD=0\nACCENSIONE=0\nSALVASCHERMO_LG=0\n' > $DATI/opzioni
  # Home LG rimossa dalla dashboard (blockSystemApp): torna disponibile
  luna-send -n 1 -w 5000 luna://com.webos.applicationManager/releaseBlockSystemApp '{"id":"com.webos.app.home"}' >/dev/null 2>&1
  echo "Home, accensione e salvaschermo tornano quelli LG."
fi
date +%s > /tmp/dashboard-salta-home
luna-send -n 1 luna://com.webos.applicationManager/launch '{"id":"com.webos.app.home"}' >/dev/null 2>&1
EOF
)

OPZ=""; [ -f "$HOME/.ssh/id_dashboard_tv" ] && OPZ="-i $HOME/.ssh/id_dashboard_tv"
ssh $OPZ root@"$TV" "$REMOTO"
