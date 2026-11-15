#!/bin/sh
# Raccoglie dalla TV i nomi reali dei servizi (canali, ingressi, Home, salvaschermo) per verificare
# o correggere le funzioni che su webOS cambiano da una versione all'altra.
# Uso (da Git Bash):  ./diagnostica.sh [ip-tv]   ->  crea diagnostica.txt
# Nella parte finale segui le istruzioni a schermo: premi Home, apri un'app, cambia ingresso.

TV="${1:-192.168.1.50}"
DIR="$(cd "$(dirname "$0")" && pwd)"

REMOTO=$(cat <<'EOF'
exec </dev/null
echo "== Sistema"
cat /var/run/nyx/os_info.json 2>/dev/null | grep -E 'webos_release"|webos_build_id'

prova() { echo "-- $1 $2"; luna-send -n 1 -w 4000 "$1" "$2" 2>&1 | grep -v 'LUNASERVICE ERROR' | head -c 2500; echo; }

echo "== Canale e guida programmi"
prova luna://com.webos.service.apiadapter/tv/getCurrentChannel '{}'
CANALE=$(luna-send -n 1 -w 4000 luna://com.webos.service.apiadapter/tv/getCurrentChannel '{}' 2>/dev/null |
  sed -n 's/.*"channelId": *"\([^"]*\)".*/\1/p')
prova luna://com.webos.service.apiadapter/tv/getChannelCurrentProgramInfo '{}'
prova luna://com.webos.service.apiadapter/tv/getChannelProgramInfo "{\"channelId\":\"$CANALE\"}"

echo "== Audio e ingressi"
prova luna://com.webos.service.apiadapter/audio/getMute '{}'
prova luna://com.webos.service.eim/getCurrentInput '{}'

echo "== App di sistema: Home, launcher, salvaschermo"
ls /usr/palm/applications 2>/dev/null | grep -iE 'home|launch|screensaver|saver|dashboard|gallery|always'

echo "== Metodi Luna: alimentazione e salvaschermo"
grep -rhoE 'com\.(webos|lge|palm)\.[A-Za-z0-9.]+/[A-Za-z0-9/]+' /usr/share/luna-service2 /etc/luna-service2 2>/dev/null |
  grep -iE 'tvpower|screensaver|launcher|home' | sort -u | head -150

echo "== Eventi"
T=/tmp/dashboard-diag
luna-send -i luna://com.webos.applicationManager/getForegroundAppInfo '{"subscribe":true}' > $T.primo 2>&1 &
P1=$!
luna-send -i luna://com.webos.applicationManager/getAppLifeEvents '{"subscribe":true}' > $T.ciclo 2>&1 &
P2=$!
luna-send -i luna://com.webos.service.tvpower/power/getPowerState '{"subscribe":true}' > $T.power 2>&1 &
P3=$!
fase() { echo; echo ">>> $1"; sleep "$2"; }
fase "ORA premi HOME sul telecomando e aspetta che compaia la Home (15 s)" 15
fase "ORA apri un'app qualsiasi, per esempio YouTube (15 s)" 15
fase "ORA premi di nuovo HOME (10 s)" 10
fase "ORA cambia ingresso, per esempio passa a HDMI 1 (15 s)" 15
kill $P1 $P2 $P3 2>/dev/null
echo; echo "-- primo piano"; cat $T.primo
echo "-- ciclo app"; grep -E '"event": *"(launch|foreground|splash)"' $T.ciclo | head -60
echo "-- alimentazione"; cat $T.power
rm -f $T.primo $T.ciclo $T.power
echo "== Fine"
EOF
)

OPZ=""; [ -f "$HOME/.ssh/id_dashboard_tv" ] && OPZ="-i $HOME/.ssh/id_dashboard_tv"
ssh $OPZ root@"$TV" "$REMOTO" 2>&1 | grep -v 'post-quantum\|store now, decrypt\|openssh.com/pq' | tee "$DIR/diagnostica.txt"
echo
echo "Risultato salvato in $DIR/diagnostica.txt"
