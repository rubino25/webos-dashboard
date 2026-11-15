#!/bin/sh
# Servizio in background della dashboard, eseguito come root:
#  - registra app e ingressi usati (tile "recenti")
#  - se attivato, sostituisce Home e salvaschermo LG e apre la dashboard all'accensione
#  - timer di spegnimento
#  - pagina web di configurazione (configura.py, porta 8095)
#
# Uso: servizio.sh start | stop | run | opzioni | imposta H A S [home_ids] [salvaschermo_ids]
#                  ripristina | home-lg | salta-home | tasto-home | timer MIN | annulla-timer | stato-timer | spegni | riavvia
#                  web on|off
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

apri_salvaschermo() {
  [ "$(secondi_da "$ULTIMO_SALVASCHERMO")" -lt 5 ] && return
  date +%s > "$ULTIMO_SALVASCHERMO"
  luna-send -n 1 -w 4000 luna://com.webos.service.tvpower/power/turnOnScreen '{}' >/dev/null 2>&1 </dev/null
  apri_dashboard '{"salvaschermo":true}'
}

monitor_app() {
  while :; do
    ultimo=""
    luna-send -i luna://com.webos.applicationManager/getForegroundAppInfo '{"subscribe":true}' 2>/dev/null |
    while read -r riga; do
      id=$(echo "$riga" | sed -n 's/.*"appId": *"\([^"]*\)".*/\1/p')
      [ -n "$id" ] && [ "$id" != "$ultimo" ] || continue
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
  atteso=$(printf '#!/bin/sh\n[ -f %s/servizio.sh ] && sh %s/servizio.sh start\nexit 0' "$cartella" "$cartella")
  if [ "$(cat "$hook" 2>/dev/null)" != "$atteso" ]; then
    mkdir -p /var/lib/webosbrew/init.d
    printf '%s\n' "$atteso" > "$hook"
  fi
  [ -x "$hook" ] || chmod +x "$hook"
  # Residui della versione 1.0
  if [ -f /tmp/dashboard-tracker.pid ]; then ferma /tmp/dashboard-tracker.pid; fi
  rm -f /var/lib/webosbrew/init.d/dashboard-recenti
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
    ;;
  tasto-home)
    # Tasto Home intercettato: dashboard, oppure Home LG se la dashboard è già davanti o non è la Home scelta
    leggi_opzioni
    davanti=$(luna-send -n 1 -w 2000 luna://com.webos.applicationManager/getForegroundAppInfo '{}' 2>/dev/null </dev/null |
      sed -n 's/.*"appId": *"\([^"]*\)".*/\1/p')
    if [ "$HOME_DASHBOARD" = 1 ] && [ "$davanti" != "$APP_ID" ]; then
      apri_dashboard
    else
      sh "$0" home-lg
    fi
    ;;
  ripristina)
    leggi_opzioni
    sh "$0" imposta 0 0 0 "$HOME_IDS" "$SALVASCHERMO_IDS"
    echo "Home, accensione e salvaschermo tornano quelli LG."
    ;;
  salta-home)
    date +%s > "$SALTA_HOME"
    ;;
  home-lg)
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
