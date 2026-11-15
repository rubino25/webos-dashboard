#!/bin/sh
# Revoca l'accesso SSH dedicato alla TV: toglie la chiave "dashboard-tv" da
# authorized_keys sulla TV e cancella la chiave dal PC.
# Uso (da Git Bash):  ./revoca-accesso.sh [ip-tv]
# Chiede la password root se la chiave non è più valida; le altre chiavi autorizzate restano.

TV="${1:-192.168.1.50}"
NOME=dashboard-tv
CHIAVE="$HOME/.ssh/id_dashboard_tv"

REMOTO=$(cat <<EOF
F=\$HOME/.ssh/authorized_keys
if [ -f "\$F" ]; then
  grep -v '$NOME' "\$F" > "\$F.tmp"
  cat "\$F.tmp" > "\$F"
  rm -f "\$F.tmp"
fi
if [ -f "\$F" ] && grep -q '$NOME' "\$F"; then echo ANCORA_PRESENTE; else echo REVOCATA; fi
EOF
)

# Prova prima con la chiave stessa, poi con la password
OPZ=""; [ -f "$CHIAVE" ] && OPZ="-i $CHIAVE"
esito=$(ssh -o ConnectTimeout=10 $OPZ root@"$TV" "$REMOTO" 2>/dev/null | tail -n 1)

case "$esito" in
  REVOCATA)
    echo "Chiave $NOME rimossa dalla TV $TV."
    rm -f "$CHIAVE" "$CHIAVE.pub"
    echo "Chiave cancellata dal PC: non si può più usare per collegarsi alla TV."
    ;;
  ANCORA_PRESENTE)
    echo "ATTENZIONE: la chiave è ancora in authorized_keys sulla TV. Rimuovila a mano." >&2
    exit 1
    ;;
  *)
    echo "Collegamento alla TV $TV non riuscito: la chiave sulla TV non è stata toccata." >&2
    echo "Controlla che la TV sia accesa e riprova." >&2
    exit 1
    ;;
esac
