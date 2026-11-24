#!/bin/sh
# Servizio in background della dashboard, eseguito come root:
#  - registra app e ingressi usati (tile "recenti")
#  - se attivato, sostituisce Home e salvaschermo LG e apre la dashboard all'accensione
#  - timer di spegnimento
#  - pagina web di configurazione (configura.py, porta 8095)
#  - Home LG rimossa e aggiornamenti LG bloccati, riapplicati se il sistema li annulla
#
# Uso: servizio.sh start | stop | run | opzioni | imposta H A S [home_ids] [salvaschermo_ids]
#                  ripristina | home-lg | salta-home | tasto-home | timer MIN | annulla-timer | stato-timer | spegni | riavvia
#                  web on|off | rimuovi-home | ripristina-home | aggiornamenti blocca|sblocca | alleggerisci on|off
#
# Emergenza da SSH, per tornare a Home e salvaschermo LG:  sh servizio.sh ripristina
APP_ID=it.casa.dashboard
DIR=/var/lib/webosbrew/dashboard
FILE=$DIR/recenti.txt
OPZIONI=$DIR/opzioni
FILE_TIMER=$DIR/timer
FILE_CANALE=$DIR/canale.json
PRIMO_PIANO=$DIR/primo_piano
LIVETV=com.webos.app.livetv
PID=/tmp/dashboard-servizio.pid
PID_TIMER=/tmp/dashboard-timer.pid
SALTA_HOME=/tmp/dashboard-salta-home
# Se Home viene premuto di nuovo entro questi secondi dal reindirizzamento, resta la Home LG
DOPPIO_HOME=6

in_esecuzione() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

# Con setsid il pid è anche il gruppo: così terminano pure i luna-send figli
ferma() {
  if in_esecuzione "$1"; then kill -- "-$(cat "$1")" 2>/dev/null || kill "$(cat "$1")"; fi
  rm -f "$1"
}

avvia_staccato() {
  if command -v setsid >/dev/null 2>&1; then
    setsid sh "$0" "$@" >/dev/null 2>&1 </dev/null &
  else
    nohup sh "$0" "$@" >/dev/null 2>&1 </dev/null &
  fi
}

leggi_opzioni() {
  HOME_DASHBOARD=0
  ACCENSIONE=0
  SALVASCHERMO_LG=0
  HOME_IDS="com.webos.app.home"
  SALVASCHERMO_IDS="com.webos.app.screensaver"
  [ -f "$OPZIONI" ] && . "$OPZIONI"
}

contiene() { case " $1 " in *" $2 "*) return 0 ;; esac; return 1; }

# ---------- Home LG rimossa ----------
# blockSystemApp è la funzione di LG per togliere un'app di sistema: la Home LG resta nella memoria di sola
# lettura, ma il sistema non la carica più (elenco in BLOCCATE).
# All'avvio però SAM riscrive quell'elenco con quello che riceve da LG (provato il 17/11: dopo ~30 s la Home
# era tornata): la scelta dell'utente sta quindi in DA_RIMUOVERE e monitor_home la riapplica di continuo.
# Si annulla con releaseBlockSystemApp: "ripristina-home", "ripristina", app Home LG, ripristina-lg.sh dal PC.
HOME_LG=com.webos.app.home
BLOCCATE=/var/preferences/com.webos.applicationManager/blockedSystemAppList
DA_RIMUOVERE=$DIR/home_lg_rimossa
SENZA_DASHBOARD=$DIR/senza-dashboard.sh

# Bloccata adesso (stato del sistema), non la scelta dell'utente
home_lg_rimossa() { grep -qs "\"$HOME_LG\"" "$BLOCCATE"/*.json; }
# Scelta dell'utente (o bloccata comunque): per il tasto Home e il comando home-lg
home_lg_tolta() { [ -f "$DA_RIMUOVERE" ] || home_lg_rimossa; }

blocca_home_lg() {
  home_lg_rimossa || luna-send -n 1 -w 5000 luna://com.webos.applicationManager/blockSystemApp \
    "{\"id\":\"$HOME_LG\",\"forceBlockSystemApp\":false}" >/dev/null 2>&1 </dev/null
  home_lg_rimossa && chiudi_processo_home
}

rilascia_home_lg() {
  rm -f "$DA_RIMUOVERE"
  home_lg_rimossa || return 0
  luna-send -n 1 -w 5000 luna://com.webos.applicationManager/releaseBlockSystemApp "{\"id\":\"$HOME_LG\"}" >/dev/null 2>&1 </dev/null
}

# ---------- Aggiornamenti LG bloccati ----------
# Il segno è quello di Homebrew Channel: a ogni avvio HBChannel e Glasshouse mettono in /etc/hosts i server
# principali (snu, su, su-dev, su-ssl). Il programma di aggiornamento (/usr/sbin/update) conosce anche
# nsu.lge.com e snu-dev.lge.com, e un indirizzo fisso: li aggiungiamo noi. Glasshouse, quando riscrive
# /etc/hosts, tiene le righe messe da altri programmi; la sua configurazione non si tocca.
# Anche la schermata "Aggiornamento software" (app di sistema nascosta) viene tolta con blockSystemApp,
# come la Home LG; il sistema la rimette all'avvio e il servizio la ritoglie quando parte.
# Il controllo della versione però non passa da quei server: con il tipo di server "sdp" (quello di
# fabbrica) la TV chiede al server generale di LG (SDP, lo stesso dello store) e a ogni accensione
# ritrovava il firmware nuovo e riproponeva l'avviso (21/11). Con il tipo "origin" il controllo va su
# snu.lge.com, bloccato. La scelta resta in /mnt/lg/cmn_data/update/.nsuServerTypeOrigin.
SEGNO_AGGIORNAMENTI=/var/luna/preferences/webosbrew_block_updates
SERVER_AGGIORNAMENTI="snu.lge.com su.lge.com su-ssl.lge.com su-dev.lge.com nsu.lge.com snu-dev.lge.com"
IP_AGGIORNAMENTI=156.147.69.32
APP_AGGIORNAMENTO=com.webos.app.softwareupdate
TIPO_SERVER_BLOCCATO=/mnt/lg/cmn_data/update/.nsuServerTypeOrigin

tipo_server_aggiornamenti() {
  luna-send -n 1 -w 5000 luna://com.webos.service.update/setServerType "{\"type\":\"$1\"}" >/dev/null 2>&1 </dev/null
}

# All'accensione (avvio a freddo) LG controlla la versione a ~24 s, PRIMA che Homebrew Channel parta (~33 s):
# sulla TV niente può bloccare quel primo controllo (22/11). Il blocco vero va quindi fatto nel DNS della rete
# (per esempio con AdGuard Home), che deve rispondere 0.0.0.0 per i server qui sotto.
# Quello che fa questo servizio resta solo un rinforzo, applicato una volta all'avvio (niente controlli periodici).

aggiornamenti_bloccati() { [ -f "$SEGNO_AGGIORNAMENTI" ]; }
app_bloccata() { grep -qs "\"$1\"" "$BLOCCATE"/*.json; }

applica_blocco_aggiornamenti() {
  aggiornamenti_bloccati || return 0
  mancanti=""
  for h in $SERVER_AGGIORNAMENTI; do
    grep -qE "^(0\.0\.0\.0|127\.0\.0\.1)[[:space:]]+$h([[:space:]]|\$)" /etc/hosts 2>/dev/null || mancanti="$mancanti $h"
  done
  if [ -n "$mancanti" ]; then
    { echo "# Aggiornamenti LG bloccati (dashboard)"; for h in $mancanti; do printf '0.0.0.0\t%s\n::\t%s\n' "$h" "$h"; done; } >> /etc/hosts
  fi
  iptables -C OUTPUT -d "$IP_AGGIORNAMENTI" -j REJECT 2>/dev/null || iptables -I OUTPUT -d "$IP_AGGIORNAMENTI" -j REJECT 2>/dev/null
  [ -f "$TIPO_SERVER_BLOCCATO" ] || tipo_server_aggiornamenti origin
  app_bloccata "$APP_AGGIORNAMENTO" || luna-send -n 1 -w 5000 luna://com.webos.applicationManager/blockSystemApp \
    "{\"id\":\"$APP_AGGIORNAMENTO\",\"forceBlockSystemApp\":false}" >/dev/null 2>&1 </dev/null
}

# ---------- App precaricate da LG ----------
# LG carica di nascosto alcune app per aprirle prima (webos-preload-manager, "reason":"preload" nella riga di
# comando). Provato il 17/11: Prime Video e il browser sono "oneshot" (caricati una volta all'avvio, ~140 MB),
# Netflix invece è "pinup reserved": chiusa, LG la ricarica in meno di 5 s, quindi resta.
# Con ALLEGGERISCI le chiude due minuti dopo, se da quando sono partite non sono mai state in primo piano
# (aperte dall'utente: restano e riprendono da dov'erano).
ALLEGGERISCI=$DIR/alleggerisci
PRECARICATE="amazon:ignition com.webos.app.browser:chrome"   # appId:nome del processo

chiudi_precaricate() {
  [ -f "$ALLEGGERISCI" ] || return 0
  adesso=$(date +%s)
  avvio=$(sed -n 's/^btime //p' /proc/stat)
  for coppia in $PRECARICATE; do
    id=${coppia%%:*}
    nome=${coppia#*:}
    for p in /proc/[0-9]*; do
      [ "$(cat "$p/comm" 2>/dev/null)" = "$nome" ] || continue
      tr '\0' ' ' < "$p/cmdline" 2>/dev/null | grep -q '"reason":"preload"' || continue
      # Partenza del processo: campo 22 di /proc/PID/stat, in centesimi di secondo dall'accensione
      inizio=$(( avvio + $(cut -d' ' -f22 "$p/stat" 2>/dev/null || echo 0) / 100 ))
      [ $((adesso - inizio)) -ge 120 ] || continue
      ultimo=$(grep " $id\$" "$FILE" 2>/dev/null | tail -n 1 | cut -d' ' -f1)
      [ -n "$ultimo" ] && [ "$ultimo" -ge "$inizio" ] && continue
      luna-send -n 1 -w 4000 luna://com.webos.applicationManager/closeByAppId "{\"id\":\"$id\"}" >/dev/null 2>&1 </dev/null
    done
  done
}

# Riapplica le scelte che il sistema può annullare (Home LG rimossa, app precaricate):
# nei primi 10 minuti ogni 15 s, poi ogni minuto (poche letture di file piccoli)
monitor_home() {
  giri=0
  while :; do
    chiudi_precaricate
    [ -f "$DA_RIMUOVERE" ] && ! home_lg_rimossa && blocca_home_lg
    giri=$((giri + 1))
    if [ "$giri" -lt 40 ]; then sleep 15; else sleep 60; fi
  done
}

# Lo esegue l'hook di avvio se la dashboard è stata disinstallata: la Home LG torna da sola
scrivi_senza_dashboard() {
  mkdir -p "$DIR"
  cat > "$SENZA_DASHBOARD" <<'EOF'
#!/bin/sh
# Generato da servizio.sh della dashboard: la dashboard non c'è più, quindi torna la Home LG.
rm -f /var/lib/webosbrew/dashboard/home_lg_rimossa
luna-send -n 1 -w 5000 luna://com.webos.applicationManager/releaseBlockSystemApp '{"id":"com.webos.app.home"}' >/dev/null 2>&1 </dev/null
exit 0
EOF
  chmod +x "$SENZA_DASHBOARD"
}

# Il processo della Home resta in memoria (~100 MB) anche quando il sistema non la conosce più
chiudi_processo_home() {
  for p in /proc/[0-9]*; do
    [ "$(cat "$p/comm" 2>/dev/null)" = fapp.home ] && kill "${p#/proc/}" 2>/dev/null
  done
}

# Con la Home LG rimossa, chiudendo un'app non resta niente in primo piano: al suo posto la dashboard.
# Si aspetta un attimo (passaggio tra un'app e l'altra) e solo a TV accesa (non in standby o a schermo spento).
nulla_davanti() {
  sleep 1
  davanti=$(luna-send -n 1 -w 2000 luna://com.webos.applicationManager/getForegroundAppInfo '{}' 2>/dev/null </dev/null |
    sed -n 's/.*"appId": *"\([^"]*\)".*/\1/p')
  [ -z "$davanti" ] || return 0
  luna-send -n 1 -w 2000 luna://com.webos.service.tvpower/power/getPowerState '{}' 2>/dev/null </dev/null |
    grep -q '"state": *"Active"' && apri_dashboard
}

apri_dashboard() {
  if [ -n "$1" ]; then p=$1; else p='{}'; fi
  luna-send -n 1 luna://com.webos.applicationManager/launch "{\"id\":\"$APP_ID\",\"params\":$p}" >/dev/null 2>&1 </dev/null
}

spegni_tv() {
  for m in turnOff powerOff; do
    luna-send -n 1 "luna://com.webos.service.tvpower/power/$m" '{"reason":"remoteKey"}' 2>/dev/null |
      grep -q '"returnValue": *true' && return 0
  done
  return 1
}

registra() {
  echo "$(date +%s) $1" >> "$FILE"
  if [ "$(wc -l < "$FILE")" -gt 100 ]; then
    tail -n 50 "$FILE" > "$FILE.tmp" && mv "$FILE.tmp" "$FILE"
  fi
}

# Il canale in onda si può leggere solo mentre Live TV trasmette: lo salviamo per la dashboard
salva_canale() {
  luna-send -n 1 -w 4000 luna://com.webos.service.apiadapter/tv/getCurrentChannel '{}' > "$FILE_CANALE.tmp" 2>/dev/null </dev/null
  if grep -q '"returnValue": *true' "$FILE_CANALE.tmp" 2>/dev/null; then
    mv "$FILE_CANALE.tmp" "$FILE_CANALE"
  else
    rm -f "$FILE_CANALE.tmp"
  fi
}

monitor_canale() {
  while :; do
    [ "$(cat "$PRIMO_PIANO" 2>/dev/null)" = "$LIVETV" ] && salva_canale
    sleep 20
  done
}

# La dashboard chiede di non reindirizzare la prossima Home (pulsante "Home LG" o uscita)
# Vale per qualche secondo e per tutti gli eventi di quella Home (primo piano e ciclo di vita)
salta_home_richiesto() {
  [ -f "$SALTA_HOME" ] || return 1
  [ "$(secondi_da "$SALTA_HOME")" -lt 8 ]
}

# ---------- Tasto Home intercettato con LG Input Hook ----------
# Con la dashboard come Home, il tasto Home (codice 773 sul telecomando della G6) non arriva al sistema:
# Input Hook esegue "servizio.sh tasto-home", quindi la Home LG non compare nemmeno per un attimo.
# Se servizio.sh non c'è più (dashboard disinstallata) il comando apre comunque la Home LG.
KEYBINDS=/home/root/.config/lginputhook/keybinds.json
TASTO_HOME=773

# Input Hook avvia il comando direttamente, senza shell (niente parentesi, || o redirezioni):
# la logica sta in uno script a parte, che funziona anche se la dashboard è stata disinstallata.
SCRIPT_TASTO=$DIR/tasto-home.sh

comando_tasto_home() {
  mkdir -p "$DIR"
  cat > "$SCRIPT_TASTO" <<EOF
#!/bin/sh
# Generato da servizio.sh della dashboard: eseguito da LG Input Hook alla pressione del tasto Home
exec </dev/null >/dev/null 2>&1
date +%s >> $DIR/tasto-home.log
S=$(cd "$(dirname "$0")" && pwd)/servizio.sh
if [ -f "\$S" ]; then exec sh "\$S" tasto-home; fi
luna-send -n 1 luna://com.webos.applicationManager/launch '{"id":"com.webos.app.home"}'
EOF
  chmod +x "$SCRIPT_TASTO"
  printf '/bin/sh %s' "$SCRIPT_TASTO"
}

# $1 = 1 aggiunge l'intercettazione, 0 la toglie. Le altre associazioni di Input Hook restano.
imposta_tasto_home() {
  [ -d "$(dirname "$KEYBINDS")" ] || return 0  # Input Hook non installato
  # Intercettazione sospesa (file presente): la regola viene solo tolta, mai aggiunta
  [ -f "$DIR/tasto_home_disattivo" ] && set -- 0
  command -v python3 >/dev/null 2>&1 || return 0
  python3 - "$KEYBINDS" "$TASTO_HOME" "$1" "$(comando_tasto_home)" <<'PY'
import json, os, sys
percorso, tasto, attiva, comando = sys.argv[1], sys.argv[2], sys.argv[3] == "1", sys.argv[4]
try:
    with open(percorso) as f:
        dati = json.load(f)
except Exception:
    dati = {}
nostro = isinstance(dati.get(tasto), dict) and "tasto-home" in str(dati[tasto].get("command", ""))
if attiva:
    nuovo = {"action": "exec", "command": comando}
    if dati.get(tasto) == nuovo:
        sys.exit(0)
    if tasto in dati and not nostro:
        sys.exit(0)  # il tasto Home è già usato da un'altra regola dell'utente: non la tocchiamo
    dati[tasto] = nuovo
elif nostro:
    del dati[tasto]
else:
    sys.exit(0)
temp = percorso + ".tmp"
with open(temp, "w") as f:
    json.dump(dati, f)
os.replace(temp, percorso)
PY
}

# Home e salvaschermo LG compaiono come app in sovrimpressione: su webOS 11.2 si vedono negli
# eventi del ciclo di vita delle app (getAppLifeEvents) e non sempre come app in primo piano.
# Entrambe le fonti passano da qui; lo stato condiviso sta in file perché i monitor sono processi diversi.
ULTIMO_REINDIRIZZO=/tmp/dashboard-ultimo-reindirizzo
ULTIMO_SALVASCHERMO=/tmp/dashboard-ultimo-salvaschermo

secondi_da() { echo $(( $(date +%s) - $(cat "$1" 2>/dev/null || echo 0) )); }

gestisci_app_sistema() {
  id=$1
  leggi_opzioni
  if [ "$HOME_DASHBOARD" = 1 ] && contiene "$HOME_IDS" "$id"; then
    if salta_home_richiesto; then
      :
    elif [ "$(secondi_da "$ULTIMO_REINDIRIZZO")" -lt "$DOPPIO_HOME" ]; then
      : # Home premuto di nuovo subito dopo (o evento doppio dello stesso tasto): resta la Home LG
    else
      date +%s > "$ULTIMO_REINDIRIZZO"
      apri_dashboard
    fi
  elif [ "$SALVASCHERMO_LG" = 1 ] && contiene "$SALVASCHERMO_IDS" "$id"; then
    apri_salvaschermo
  fi
}

# Il lettore multimediale LG (DLNA, usato anche dall'app Film) e quello della musica si chiudono se un'altra
# app passa davanti: un film in pausa andava perso quando partiva il nostro salvaschermo (22/11).
# Con uno di loro in primo piano resta il salvaschermo LG, che non chiude niente.
LETTORI="com.webos.app.mediadiscovery com.webos.app.totalmusic"

apri_salvaschermo() {
  [ "$(secondi_da "$ULTIMO_SALVASCHERMO")" -lt 5 ] && return
  contiene "$LETTORI" "$(cat "$PRIMO_PIANO" 2>/dev/null)" && return
  date +%s > "$ULTIMO_SALVASCHERMO"
  luna-send -n 1 -w 4000 luna://com.webos.service.tvpower/power/turnOnScreen '{}' >/dev/null 2>&1 </dev/null
  apri_dashboard '{"salvaschermo":true}'
}

monitor_app() {
  while :; do
    ultimo="-"
    luna-send -i luna://com.webos.applicationManager/getForegroundAppInfo '{"subscribe":true}' 2>/dev/null |
    while read -r riga; do
      case "$riga" in *'"appId"'*) ;; *) continue ;; esac
      id=$(echo "$riga" | sed -n 's/.*"appId": *"\([^"]*\)".*/\1/p')
      [ "$id" != "$ultimo" ] || continue
      if [ -z "$id" ]; then
        # Niente in primo piano (succede solo con la Home LG rimossa): ci va la dashboard
        ultimo=""
        home_lg_rimossa && nulla_davanti &
        continue
      fi
      # Uscendo da Live TV la trasmissione è ancora attiva per un attimo: ultimo canale visto
      [ "$ultimo" = "$LIVETV" ] && salva_canale
      ultimo=$id
      echo "$id" > "$PRIMO_PIANO"
      registra "$id"
      gestisci_app_sistema "$id"
    done
    # luna-send è uscito (es. riavvio del servizio di sistema): riprova
    sleep 5
  done
}

monitor_ciclo_app() {
  while :; do
    luna-send -i luna://com.webos.applicationManager/getAppLifeEvents '{"subscribe":true}' 2>/dev/null |
    while read -r riga; do
      case "$riga" in *'"event"'*'"launch"'*|*'"event"'*'"foreground"'*) ;; *) continue ;; esac
      id=$(echo "$riga" | sed -n 's/.*"appId": *"\([^"]*\)".*/\1/p')
      [ -n "$id" ] || continue
      leggi_opzioni
      contiene "$HOME_IDS $SALVASCHERMO_IDS" "$id" && gestisci_app_sistema "$id"
    done
    sleep 5
  done
}

# Pagina web di configurazione (http://<ip-tv>:8095): se si chiude per un errore, ripartirà.
# Spenta dall'utente (file WEB_SPENTA): il server non gira e il ciclo controlla ogni 3 s se riaccenderlo.
WEB_SPENTA=$DIR/configura_spenta
PID_WEB=/tmp/dashboard-configura.pid

monitor_configura() {
  configura="$(cd "$(dirname "$0")" && pwd)/configura.py"
  while [ -f "$configura" ]; do
    if [ -f "$WEB_SPENTA" ]; then sleep 3; continue; fi
    python3 "$configura" >/dev/null 2>&1 </dev/null &
    echo $! > "$PID_WEB"
    wait $!
    rm -f "$PID_WEB"
    [ -f "$WEB_SPENTA" ] || sleep 10
  done
}

monitor_accensione() {
  while :; do
    prec=""
    luna-send -i luna://com.webos.service.tvpower/power/getPowerState '{"subscribe":true}' 2>/dev/null |
    while read -r riga; do
      stato=$(echo "$riga" | sed -n 's/.*"state": *"\([^"]*\)".*/\1/p')
      [ -n "$stato" ] || continue
      leggi_opzioni
      # Accensione da standby (non la semplice riaccensione dello schermo)
      if [ "$stato" = "Active" ] && [ -n "$prec" ] && [ "$prec" != "Active" ] && [ "$prec" != "Screen Off" ] &&
         [ "$ACCENSIONE" = 1 ]; then
        sleep 4
        apri_dashboard
      fi
      # Il salvaschermo LG non è un'app ma uno stato di alimentazione (verificato su webOS 11.2):
      # lo si chiude riaccendendo lo schermo e al suo posto si apre quello della dashboard
      if [ "$stato" = "Screen Saver" ] && [ "$prec" != "Screen Saver" ] && [ "$SALVASCHERMO_LG" = 1 ]; then
        apri_salvaschermo
      fi
      prec=$stato
    done
    sleep 5
  done
}

# Avvio automatico a ogni accensione tramite Homebrew Channel. Lo crea il servizio stesso,
# così basta installare l'IPK (anche da webOS Dev Manager) e aprire l'app una volta.
# Se l'app viene disinstallata, lo script non trova più servizio.sh e non fa nulla.
installa_avvio() {
  cartella=$(cd "$(dirname "$0")" && pwd)
  hook=/var/lib/webosbrew/init.d/dashboard
  # Dashboard disinstallata: l'hook fa tornare la Home LG, se era stata rimossa
  scrivi_senza_dashboard
  atteso=$(printf '#!/bin/sh\nif [ -f %s/servizio.sh ]; then sh %s/servizio.sh start; else sh %s; fi\nexit 0' "$cartella" "$cartella" "$SENZA_DASHBOARD")
  if [ "$(cat "$hook" 2>/dev/null)" != "$atteso" ]; then
    mkdir -p /var/lib/webosbrew/init.d
    printf '%s\n' "$atteso" > "$hook"
  fi
  [ -x "$hook" ] || chmod +x "$hook"
  # Residui della versione 1.0 e della 1.9.4 (chiusura dell'avviso di aggiornamento, superata dal blocco nel DNS)
  if [ -f /tmp/dashboard-tracker.pid ]; then ferma /tmp/dashboard-tracker.pid; fi
  rm -f /var/lib/webosbrew/init.d/dashboard-recenti /var/lib/webosbrew/init.d/00-dashboard-avviso
}

case "$1" in
  start)
    installa_avvio 2>/dev/null
    # Intercettazione del tasto Home allineata all'opzione (es. dopo un aggiornamento)
    leggi_opzioni
    imposta_tasto_home "$HOME_DASHBOARD" 2>/dev/null
    in_esecuzione "$PID" && exit 0
    avvia_staccato run
    ;;
  stop)
    ferma "$PID"
    ;;
  run)
    echo $$ > "$PID"
    mkdir -p "$DIR"
    leggi_opzioni
    # Avvio a freddo della TV: apre la dashboard quando il sistema si è assestato
    if [ "$ACCENSIONE" = 1 ] && [ "$(cut -d. -f1 /proc/uptime)" -lt 180 ]; then
      (sleep 20; apri_dashboard) &
    fi
    monitor_app &
    monitor_accensione &
    monitor_ciclo_app &
    monitor_canale &
    command -v python3 >/dev/null 2>&1 && monitor_configura &
    applica_blocco_aggiornamenti &
    monitor_home &
    wait
    ;;
  opzioni)
    leggi_opzioni
    echo "HOME_DASHBOARD=$HOME_DASHBOARD"
    echo "ACCENSIONE=$ACCENSIONE"
    echo "SALVASCHERMO_LG=$SALVASCHERMO_LG"
    echo "HOME_IDS=$HOME_IDS"
    echo "SALVASCHERMO_IDS=$SALVASCHERMO_IDS"
    if [ -f "$WEB_SPENTA" ]; then echo "PAGINA_WEB=0"; else echo "PAGINA_WEB=1"; fi
    # La scelta dell'utente (subito dopo un riavvio il sistema può non averla ancora riapplicata)
    if [ -f "$DA_RIMUOVERE" ]; then echo "HOME_LG_RIMOSSA=1"; else echo "HOME_LG_RIMOSSA=0"; fi
    if aggiornamenti_bloccati; then echo "AGGIORNAMENTI_BLOCCATI=1"; else echo "AGGIORNAMENTI_BLOCCATI=0"; fi
    if [ -f "$ALLEGGERISCI" ]; then echo "ALLEGGERISCI=1"; else echo "ALLEGGERISCI=0"; fi
    ;;
  alleggerisci)
    # Chiude le app precaricate da LG (subito quelle già partite da 2 minuti, poi le controlla monitor_home)
    case "$2" in
      on) mkdir -p "$DIR"; touch "$ALLEGGERISCI"; chiudi_precaricate ;;
      off) rm -f "$ALLEGGERISCI" ;;
      *) echo "Uso: $0 alleggerisci on|off" >&2; exit 1 ;;
    esac
    ;;
  aggiornamenti)
    case "$2" in
      blocca)
        touch "$SEGNO_AGGIORNAMENTI"
        sync
        applica_blocco_aggiornamenti
        # Toglie l'avviso di un aggiornamento già trovato prima del blocco
        luna-send -n 1 -w 5000 luna://com.webos.service.update/deleteUpdateInfo '{}' >/dev/null 2>&1 </dev/null
        echo "Aggiornamenti LG bloccati."
        ;;
      sblocca)
        # Le righe in /etc/hosts restano fino al prossimo riavvio
        rm -f "$SEGNO_AGGIORNAMENTI"
        sync
        iptables -D OUTPUT -d "$IP_AGGIORNAMENTI" -j REJECT 2>/dev/null
        # Torna il controllo di fabbrica (tipo "sdp", che in origine non aveva alcun file)
        tipo_server_aggiornamenti sdp
        rm -f /mnt/lg/cmn_data/update/.nsuServerTypeSDP
        luna-send -n 1 -w 5000 luna://com.webos.applicationManager/releaseBlockSystemApp \
          "{\"id\":\"$APP_AGGIORNAMENTO\"}" >/dev/null 2>&1 </dev/null
        echo "Aggiornamenti LG di nuovo possibili dal prossimo riavvio."
        ;;
      *) echo "Uso: $0 aggiornamenti blocca|sblocca" >&2; exit 1 ;;
    esac
    ;;
  rimuovi-home)
    # La dashboard diventa l'unica Home: prima un backup delle preferenze di SAM (una volta sola)
    mkdir -p "$DIR/backup-home-lg"
    [ -d "$DIR/backup-home-lg/applicationManager-preferences" ] ||
      cp -a /var/preferences/com.webos.applicationManager "$DIR/backup-home-lg/applicationManager-preferences"
    scrivi_senza_dashboard
    leggi_opzioni
    sh "$0" imposta 1 "$ACCENSIONE" "$SALVASCHERMO_LG" "$HOME_IDS" "$SALVASCHERMO_IDS"
    blocca_home_lg
    if ! home_lg_rimossa; then echo "Rimozione della Home LG non riuscita" >&2; exit 1; fi
    touch "$DA_RIMUOVERE"
    echo "Home LG rimossa: al suo posto la dashboard (riapplicata a ogni avvio)."
    ;;
  ripristina-home)
    rilascia_home_lg
    if home_lg_rimossa; then echo "Ripristino della Home LG non riuscito" >&2; exit 1; fi
    echo "Home LG di nuovo presente."
    ;;
  web)
    # Pagina web di configurazione: on la riaccende (entro 3 s), off la spegne subito
    case "$2" in
      on) rm -f "$WEB_SPENTA" ;;
      off)
        mkdir -p "$DIR"
        touch "$WEB_SPENTA"
        in_esecuzione "$PID_WEB" && kill "$(cat "$PID_WEB")"
        rm -f "$PID_WEB"
        ;;
      *) echo "Uso: $0 web on|off" >&2; exit 1 ;;
    esac
    ;;
  imposta)
    mkdir -p "$DIR"
    h=$(echo "$2" | tr -cd 01)
    a=$(echo "$3" | tr -cd 01)
    s=$(echo "$4" | tr -cd 01)
    hid=$(echo "$5" | tr -cd 'A-Za-z0-9._ -')
    sid=$(echo "$6" | tr -cd 'A-Za-z0-9._ -')
    printf 'HOME_DASHBOARD=%s\nACCENSIONE=%s\nSALVASCHERMO_LG=%s\nHOME_IDS="%s"\nSALVASCHERMO_IDS="%s"\n' \
      "${h:-0}" "${a:-0}" "${s:-0}" "${hid:-com.webos.app.home}" "${sid:-com.webos.app.screensaver}" > "$OPZIONI"
    imposta_tasto_home "${h:-0}"
    # Se la dashboard non è più la Home, la Home LG deve esserci
    [ "${h:-0}" = 1 ] || rilascia_home_lg
    ;;
  tasto-home)
    # Tasto Home intercettato: dashboard, oppure Home LG se la dashboard è già davanti o non è la Home scelta
    leggi_opzioni
    davanti=$(luna-send -n 1 -w 2000 luna://com.webos.applicationManager/getForegroundAppInfo '{}' 2>/dev/null </dev/null |
      sed -n 's/.*"appId": *"\([^"]*\)".*/\1/p')
    # Con la Home LG rimossa c'è solo la dashboard (già davanti: torna alla panoramica)
    if home_lg_tolta || { [ "$HOME_DASHBOARD" = 1 ] && [ "$davanti" != "$APP_ID" ]; }; then
      apri_dashboard
    else
      sh "$0" home-lg
    fi
    ;;
  ripristina)
    leggi_opzioni
    sh "$0" imposta 0 0 0 "$HOME_IDS" "$SALVASCHERMO_IDS"
    rilascia_home_lg
    echo "Home, accensione e salvaschermo tornano quelli LG."
    ;;
  salta-home)
    date +%s > "$SALTA_HOME"
    ;;
  home-lg)
    if home_lg_tolta; then echo "La Home LG è stata rimossa: la ripristini dalle Impostazioni della dashboard" >&2; exit 1; fi
    leggi_opzioni
    date +%s > "$SALTA_HOME"
    for id in $HOME_IDS; do
      luna-send -n 1 luna://com.webos.applicationManager/launch "{\"id\":\"$id\"}" >/dev/null 2>&1 </dev/null
      break
    done
    ;;
  timer)
    ferma "$PID_TIMER"
    min=$(echo "$2" | tr -cd 0-9)
    if [ -z "$min" ] || [ "$min" -eq 0 ]; then rm -f "$FILE_TIMER"; exit 1; fi
    mkdir -p "$DIR"
    echo $(( $(date +%s) + min * 60 )) > "$FILE_TIMER"
    avvia_staccato esegui-timer
    ;;
  esegui-timer)
    echo $$ > "$PID_TIMER"
    fine=$(cat "$FILE_TIMER")
    while :; do
      adesso=$(date +%s)
      # TV rimasta in standby oltre la scadenza: il timer non ha più senso
      [ "$adesso" -gt $((fine + 120)) ] && break
      if [ "$adesso" -ge "$fine" ]; then spegni_tv; break; fi
      sleep 20
    done
    rm -f "$FILE_TIMER" "$PID_TIMER"
    ;;
  annulla-timer)
    ferma "$PID_TIMER"
    rm -f "$FILE_TIMER"
    ;;
  stato-timer)
    if in_esecuzione "$PID_TIMER"; then cat "$FILE_TIMER" 2>/dev/null; fi
    ;;
  spegni)
    spegni_tv || { echo "Spegnimento non riuscito" >&2; exit 1; }
    ;;
  riavvia)
    # Staccato: la risposta torna subito alla dashboard, il riavvio parte un attimo dopo
    avvia_staccato esegui-riavvio
    ;;
  esegui-riavvio)
    sleep 1
    luna-send -n 1 -w 5000 luna://com.webos.service.tvpower/power/reboot '{"reason":"remoteKey"}' 2>/dev/null </dev/null |
      grep -q '"returnValue": *true' || reboot
    ;;
  *)
    echo "Uso: $0 start|stop|run|opzioni|imposta|ripristina|home-lg|salta-home|timer MIN|annulla-timer|stato-timer|spegni" >&2
    exit 1
    ;;
esac
exit 0
