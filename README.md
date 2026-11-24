# Dashboard webOS

> **Progetto realizzato interamente con l'intelligenza artificiale, in *vibe coding*.** Codice, script e documentazione sono stati scritti da un'AI seguendo le indicazioni dell'autore, senza una revisione manuale riga per riga. Usalo sapendolo, a tuo rischio.

App a schermo intero per la TV LG rootata (Homebrew Channel), pensata per LG G6 con webOS 26. Si usa col telecomando o col puntatore del Magic Remote.

## Pagina 1: panoramica

- **Orologio e data**, con un avviso meteo per le prossime 12 ore (temporale, neve, pioggia, raffiche, gelo).
- **In onda**: canale, programma in corso con avanzamento, il successivo e il resto della serata. Con la dashboard aperta Live TV non trasmette, quindi si vede l'*ultimo canale visto*. OK riapre Live TV.
- **Meteo**: condizioni attuali e 5 giorni da Open-Meteo, senza chiave API. La città si cambia da *Impostazioni*.
- **Film**: i video del server DLNA di casa (trovato da solo in rete, o `dlna.url` in `config.json`). OK su un film lo apre nel Media Player LG (riprendi, audio, sottotitoli, episodio successivo); OK su una cartella la apre, Indietro risale.
- **Controlli**: ingresso, modalità immagine, timer di spegnimento (15–120 min), spegni TV, tutte le app, *Accendi PC* (vedi sotto), riavvia TV (spegni e riavvia chiedono conferma).
- **Accensione a distanza (Wake-on-LAN)**: in *Impostazioni → Accensione a distanza* scrivi nome e MAC del dispositivo (*Prova* lo accende subito). Poi scegli come accenderlo, anche in tutti e due i modi:
  - *Accendilo scegliendo l'ingresso*: quando apri quell'ingresso dalla dashboard (menu *Ingresso*, tile *Ultimo ingresso*, preferite) parte da solo il pacchetto di accensione. Non parte con Indietro né scegliendo l'ingresso dai menu LG.
  - *Pulsante tra i comandi*: la pillola *Accendi <nome>* accanto a *Riavvia TV*.
  
  Il pacchetto lo manda la TV (`app/wol.py`, in broadcast sulla rete di casa). Il dispositivo deve essere collegato alla rete **via cavo** (non basta il cavo dell'extender HDMI) e avere il Wake-on-LAN attivo nel BIOS e nella scheda di rete; su Windows conviene disattivare l'*Avvio rapido*.
- **App**: *Ultimo ingresso*, *Ultima app*, *App precedente*, poi le **app preferite**. L'ultima tile *Scegli app* (o *Impostazioni → App preferite*) apre l'elenco di tutte le app: OK aggiunge o toglie. OK tenuto premuto su una preferita: sposta, togli o **disinstalla**; in *Tutte le app* OK tenuto premuto: apri o **disinstalla** (con conferma; solo le app rimovibili, non quelle di sistema LG né dashboard, Home LG, Homebrew Channel, Input Hook e Glasshouse).
- **Azioni** in alto: Impostazioni, Aggiorna, Home LG, Spegni schermo.

Con **▼** dalla barra delle app si passa alla pagina 2, con **▲** o Indietro si torna su.

## App Film

App a parte (icona *Film* nel launcher, aggiungibile ai preferiti) con tutti i video del server DLNA:

- **Vetrina** in alto col titolo selezionato: anno, durata, qualità, voto, trama e sfondo (da TMDB).
- **Continua a guardare**: film iniziati e serie con l'episodio da riprendere. OK chiede *Riprendi da…* o *Dall'inizio*.
- **Tutti**: locandine con ricerca (*Cerca un titolo*) e ordinamento (*Aggiunti di recente*, *Titolo A–Z*, *Anno*).
- **Serie**: gli episodi `SxxEyy` sono raggruppati in una sola locandina; OK apre gli episodi divisi per stagione.
- **OK tenuto premuto**: segna come visto / da vedere, segna visti gli episodi precedenti, togli da *Continua a guardare*.
- I video si aprono nel **Media Player LG** (audio, sottotitoli, episodio successivo). Un piccolo processo da root (`film/traccia.py`) segue la riproduzione, salva il punto raggiunto in `/var/lib/webosbrew/dashboard/film-posizioni.json` e, se si riprende, porta il video al punto giusto. Oltre il 95% il video conta come visto.
- **Locandine e trame**: servono una chiave gratuita di [TMDB](https://www.themoviedb.org/settings/api) (account → Impostazioni → API) in `config.json` → `tmdb.apiKey` (vanno bene sia la *chiave API* sia il *token di lettura*), poi `installa.sh`. Senza chiave le locandine sono colorate col titolo.
- Indietro: chiude la serie aperta, poi svuota la ricerca, poi torna alla dashboard.
- **Tasto Netflix** del telecomando: apre Film invece di Netflix. È una regola di LG Input Hook (codice `1037` → `/bin/sh /var/lib/webosbrew/dashboard/tasto-film.sh`) in `/home/root/.config/lginputhook/keybinds.json`; per riavere Netflix togli la voce `1037` (copia di prima: `keybinds.json.prima-netflix`). *Ripristina Home LG* non la tocca.

## Configurazione dal PC o dal telefono

Con la TV accesa apri **http://IP-DELLA-TV:8095** da un browser della rete di casa (l'indirizzo è scritto anche in alto nel pannello *Impostazioni*). Ogni modifica è salvata subito sulla TV e, se la dashboard è aperta, compare all'istante.

- **Meteo e orologio**: città (ricerca con più risultati tra cui scegliere), secondi.
- **App preferite**: ordine con ▲ ▼, togli con ✕, aggiungi dalla griglia (con filtro per nome).
- **Avvio, Home e salvaschermo**: le stesse opzioni del pannello sulla TV.
- **Accensione a distanza**: nome, MAC, ingresso collegato, pulsante, prova.

**Accendere o spegnere la pagina**: sulla TV, *Impostazioni → Pagina web: Sì/No* (in alto a destra nel pannello); oppure, dalla pagina stessa, *Spegni la pagina web* (per riaccenderla serve la TV). Da SSH: `sh servizio.sh web on|off`. Spenta, il server non gira affatto.

### Stato della TV per altri dispositivi (`/api/sistema`)

Lo stesso server risponde anche a **`GET http://IP-DELLA-TV:8095/api/sistema`**, in sola lettura: lo usa il pannello touch ESP32, che lo interroga ogni 3 secondi. Risponde in pochi millisecondi (al massimo ~0,2 s) con tutte queste chiavi, `null` se il dato non c'è:

```json
{"cpu": 23, "ram": {"usata": 2400000, "totale": 4194304}, "disco": {"usato": 7135072, "totale": 16515072},
 "temp": null, "uptime": 93784, "carico": 0.84,
 "app": {"id": "com.webos.app.livetv", "nome": "Live TV"}, "sorgente": "Live TV",
 "canale": {"numero": "5", "nome": "Canale 5", "programma": "Film della sera", "inizio": "20:30", "fine": "22:00"},
 "media": null, "immagine": "Cinema", "volume": 12, "muto": false,
 "audio": {"uscita": "Soundbar (eARC)", "modalita": "AI Sound Pro"},
 "info": {"modello": "OLED55XXXXX", "webos": "x.y.z", "firmware": "xx.yy.zz", "dashboard": "1.7.3"},
 "rete": {"connessione": "Wi-Fi", "segnale": "ottimo", "ip": "192.168.1.50", "download": 1330809, "upload": 66540}}
```

| Chiave | Contenuto |
|---|---|
| `cpu` | uso % (intero), dal confronto con la lettura precedente di `/proc/stat` |
| `ram`, `disco` | kB usati e totali (`/proc/meminfo`, `/media/internal`) |
| `temp` | °C; la G6 non ha sensori leggibili, quindi `null` |
| `uptime`, `carico` | secondi dall'accensione, carico medio di 1 minuto |
| `app` | app davanti: id e nome come nel launcher |
| `sorgente` | `Live TV`, `HDMI 1`…`HDMI 4`, oppure il nome dell'app |
| `canale` | solo con Live TV davanti: numero, nome, programma in corso con inizio e fine (`null` se la guida non lo ha) |
| `media` | solo col Media Player LG: titolo (dal server DLNA), posizione e durata in secondi, `stato` `play` o `pause` |
| `immagine` | modalità immagine della sorgente attuale (`Cinema`, `Filmmaker`, `HDR cinema`, …) |
| `volume`, `muto` | volume 0–100 e muto sì/no |
| `audio` | `uscita` (`Altoparlanti TV`, `Soundbar (eARC)`, `Ottico`, `Bluetooth`, `Cuffie`, …) e `modalita` audio (`AI Sound Pro`, `Standard`, `Cinema`, `Voce chiara`, `Sport`, `Musica`, `Gioco`, …) |
| `info` | `modello`, versione di `webos`, `firmware` e della `dashboard`: letti all'avvio del server |
| `rete` | `connessione` (`Wi-Fi` o `Cablata`), `segnale` Wi-Fi (`ottimo`, `buono`, `discreto`, `debole`; `null` se cablata), `ip`, `download` e `upload` in bit/s (dal confronto con la lettura precedente di `/proc/net/dev`) |

Non serve password e non cambia nulla sulla TV. Con la pagina web spenta (*Pagina web: No*) anche `/api/sistema` non risponde.

Home Assistant resta fuori: i gruppi della card *Casa* si gestiscono già in HA con le etichette. La pagina la serve `app/configura.py`, avviato da `servizio.sh` come root (in attesa non usa CPU, circa 15 MB di memoria). Le impostazioni stanno in `/var/lib/webosbrew/dashboard/impostazioni.json`, condiviso con la dashboard. ⚠️ Per ora la pagina **non ha password**: chiunque sia sulla rete di casa può aprirla.

## Pagina 2: sistema e casa

- **Sistema**: CPU, memoria, spazio, uptime, carico, processi, IP, connessione, download/upload, webOS e firmware.
- **Casa**: entità di Home Assistant divise in gruppi (vedi sotto). Luci, prese, tapparelle e interruttori si accendono/spengono con OK.

## Telecomando

| Tasto | Azione |
|---|---|
| Frecce | spostarsi |
| OK | aprire / attivare |
| OK tenuto premuto su un'app | menu: *Sposta* (poi ◀ ▶ e OK) o *Nascondi* |
| Indietro | chiude il pannello, torna alla pagina 1, esce |

Le app nascoste si ripristinano da *Impostazioni → App nascoste*.

## Home, accensione e salvaschermo

Da *Impostazioni → Avvio, Home e salvaschermo*:

- **Home**: *Home LG*, *dashboard* (il tasto Home apre la dashboard; Home due volte per la Home LG) oppure *solo dashboard*, che **toglie la Home LG dal sistema** (vedi sotto).
- **Apri all'accensione della TV**.
- **Salvaschermo della dashboard**: dopo N minuti senza tasti premuti mostra ora, data e meteo in posizione sempre diversa (adatto all'OLED); con gli sfondi attivi sopra l'immagine del momento, che si muove piano e cambia ogni 90 secondi, altrimenti su nero. Un tasto qualsiasi lo chiude.
- **Sostituisci il salvaschermo LG** con quello della dashboard. Non succede se davanti c'è il lettore multimediale LG (film e foto DLNA, anche aperti dall'app Film) o quello della musica: si chiuderebbero perdendo il film in pausa, quindi resta il salvaschermo LG.
- **Sistema LG** (menu): *Chiudi le app che LG precarica* chiude Prime Video e il browser LG che la TV carica di nascosto all'avvio (~140 MB), se non li hai aperti tu; Netflix resta perché LG la ricarica subito. Aprendole partono comunque, solo un po' più lente.
- **Aggiornamenti LG: bloccati/consentiti** (nello stesso menu): un aggiornamento del firmware farebbe perdere il root. Bloccati usa il segno di Homebrew Channel (`/var/luna/preferences/webosbrew_block_updates`, con cui HBChannel e Glasshouse bloccano a ogni avvio i server principali in `/etc/hosts`) e in più blocca `nsu.lge.com`, `snu-dev.lge.com` e l'indirizzo fisso `156.147.69.32` che il programma di aggiornamento LG conosce, toglie la schermata *Aggiornamento software* (`com.webos.app.softwareupdate`, come la Home LG) e sposta il controllo della versione dal server generale di LG (SDP, che non si può bloccare senza perdere lo store) ai server bloccati (`setServerType origin`, file `/mnt/lg/cmn_data/update/.nsuServerTypeOrigin`): senza questo l'avviso dell'aggiornamento tornava a ogni accensione. All'accensione però LG controlla prima che Homebrew Channel parta: senza un blocco nel DNS l'avviso ricompare (con "Sì" già selezionato: non premere mai OK). Per questo conviene bloccare i server degli aggiornamenti LG anche nel DNS della rete (per esempio con AdGuard Home o Pi-hole, impostato come DNS della TV): così sono bloccati fin dall'accensione. Se il server DNS è spento la TV non risolve i nomi: si torna indietro da TV → Rete → Wi-Fi → Impostazioni avanzate → DNS automatico; `servizio.sh` li riapplica una volta quando parte. Consentirli chiede conferma e vale dal riavvio successivo. Dal PC: `sh servizio.sh aggiornamenti blocca|sblocca`.

Anche senza salvaschermo, la dashboard si sposta di qualche pixel ogni 3 minuti per non stampare l'immagine sull'OLED.

### Sfondi

*Impostazioni → Sfondi* (menu: OK attiva o toglie una voce, *Fatto* chiude):

- **Bing, foto del giorno**: paesaggi, le ultime 8 (l'elenco di Bing non permette CORS: lo scarica la TV con `curl`).
- **NASA, immagine del giorno**: dal feed *Image of the Day* (`nasa.gov/feeds/iotd-feed/`), ridotte a 1920 px con `?w=1920`. L'API *APOD* della NASA oggi restituisce solo il logo, per questo non si usa.
- **Foto del NAS**: la cartella *Foto* del server DLNA (`dlna.py immagini`), con tutte le sottocartelle; delle foto offerte in più formati prende la più piccola larga almeno 1280 px.
- **Cambia ogni** 15, 30, 60 o 120 minuti; **anche nel salvaschermo** sì/no.

Le immagini verticali, piccole o che non si caricano vengono saltate. L'elenco si rilegge ogni 6 ore e resta salvato nel browser della TV; sulla dashboard l'immagine è scurita perché card e testi si leggano. Codice in `app/js/sfondi.js`; impostazioni `sfondi`, `sfondoMin`, `sfondoSalvaschermo` in `impostazioni.json` (non ancora nella pagina web).

### Home LG rimossa ("solo dashboard")

La Home LG è un'app di sistema (`com.webos.app.home`, Flutter) nella memoria di sola lettura: cancellarla davvero non si può e scrivere lì rischierebbe di bloccare la TV. *Solo dashboard* usa invece la funzione di LG per togliere le app di sistema, `applicationManager/blockSystemApp`: il sistema non la carica più (anche dopo un riavvio; l'elenco sta in `/var/preferences/com.webos.applicationManager/blockedSystemAppList/`) e la sua memoria (~100 MB) si libera.

- Chiudendo un'app (Indietro) non resta niente in primo piano: dopo un secondo `servizio.sh` apre la dashboard. Niente più lampo della Home LG.
- Il tasto Home apre sempre la dashboard; il pulsante *Home LG* in alto sparisce.
- Prima della rimozione `servizio.sh` salva le preferenze del gestore delle app in `/var/lib/webosbrew/dashboard/backup-home-lg/`.
- All'avvio il sistema rimette la Home LG nell'elenco (lo riscrive con quello che riceve da LG): `servizio.sh` la toglie di nuovo dopo pochi secondi, e controlla ogni minuto. La scelta sta in `/var/lib/webosbrew/dashboard/home_lg_rimossa`.
- Dal PC: `./rimuovi-home-lg.sh`. Per rimetterla vale tutto l'elenco di *Tornare alla Home LG* qui sotto (tranne il punto 2 e 3).
- **Se la dashboard viene disinstallata**, al riavvio successivo l'hook di avvio (`senza-dashboard.sh`) rimette da solo la Home LG.
- ⚠️ La rimozione è un'impostazione di LG, non del root: se un giorno si perdesse il root (aggiornamento firmware) la Home LG resterebbe tolta senza la dashboard a sostituirla. Prima di qualsiasi intervento del genere, rimetti la Home LG.

### Dashboard predefinita

Per renderla definitiva (Home e accensione), dalla TV: *Impostazioni → Avvio, Home e salvaschermo*; oppure dal PC:

```bash
./attiva-dashboard.sh
```

Il salvaschermo resta come scelto nelle Impostazioni.

Con la dashboard come Home, se sulla TV c'è **LG Input Hook** il tasto Home (codice 773) viene intercettato prima del sistema: apre direttamente la dashboard, senza mostrare la Home LG nemmeno per un attimo. Premuto con la dashboard già aperta, apre la Home LG. La regola sta in `/home/root/.config/lginputhook/keybinds.json` e viene tolta da sola quando si torna alla Home LG; le altre regole di Input Hook restano.

### Tornare alla Home LG

In un attimo, in uno qualsiasi di questi modi:

1. **App "Home LG"** (icona arancione con la casetta), dalla barra della dashboard o da *Tutte le app*: riporta Home, accensione e salvaschermo a quelli LG, rimette la Home LG se era stata rimossa e la apre. Funziona anche se la dashboard non si apre o è stata disinstallata.
2. **Home con la dashboard aperta**: apre la Home LG (solo per quella volta; non con la Home LG rimossa).
3. Pulsante **Home LG** in alto nella dashboard (solo per quella volta; non c'è con la Home LG rimossa).
4. **Impostazioni → Home: Home LG**, oppure **Ripristina Home e salvaschermo LG**.
5. Dal PC, anche se sulla TV non si apre nulla:
   ```bash
   ./ripristina-lg.sh
   ```
6. Disinstallando la dashboard: il servizio non viene più avviato e, al riavvio, la Home LG rimossa torna da sola.

Per tornare alla dashboard dopo un ripristino: `./attiva-dashboard.sh` oppure le Impostazioni della dashboard.

## Installazione

Da Git Bash, con la TV accesa (chiede la password root SSH una volta):

```bash
./installa.sh IP-DELLA-TV
```

Gli script accettano l'indirizzo della TV come primo argomento (senza, usano `192.168.1.50`).

Ricrea i pacchetti in `dist/` (dashboard e app *Home LG*), li installa, configura l'avvio automatico del servizio e apre la dashboard. Per aggiornare basta rilanciarlo: le impostazioni restano.

### Con webOS Dev Manager

1. `python build.py` (anche da PowerShell) per creare in `dist/` i due pacchetti: `it.casa.dashboard_<versione>_all.ipk` e `it.casa.dashboard.homelg_<versione>_all.ipk`.
2. In Dev Manager, con la TV collegata come dispositivo rootato, installa entrambi i file `.ipk`.
3. Apri **Dashboard** sulla TV una volta: il servizio parte e da solo si registra per l'avvio automatico.

Per aggiornare si reinstalla il nuovo `.ipk` allo stesso modo; le impostazioni restano.

### Configurazione personale (facoltativa)

Copia `config.esempio.json` in `config.json`, compilalo e reinstalla con `installa.sh`:

- `dlna`: `{ "url": "http://IP:PORTA" }` del server DLNA, solo se non viene trovato da solo.
- `homeAssistant`: indirizzo **IP** (la TV non risolve `homeassistant.local`) e token a lunga durata (profilo utente → Sicurezza → Token di accesso a lunga durata). `gruppi` e `nomi` sono facoltativi (vedi sotto).
- `canaliPreferiti`: numero e nome dei canali da avere a portata di tasto.
- `homeIds`, `salvaschermoIds`: id delle app Home e salvaschermo di LG, se su webOS 26 fossero diversi da quelli predefiniti.

`config.json` viene incluso nel pacchetto ma resta fuori da `app/`.

### Gestire la card Casa da Home Assistant

Le entità e i gruppi si scelgono in Home Assistant, senza reinstallare: la dashboard li rilegge ogni 30 secondi.

1. In Home Assistant apri l'entità → ⚙ Impostazioni → **Etichette**.
2. Assegna un'etichetta che inizia con **`TV: `** seguito dal nome del gruppo, per esempio `TV: Clima`, `TV: Riscaldamento`, `TV: Energia`, `TV: Altro`. Per un gruppo nuovo basta creare un'etichetta nuova con lo stesso schema.
3. Per togliere un'entità dalla TV, rimuovi l'etichetta.

Il nome mostrato è quello dell'entità in Home Assistant. Per un nome diverso solo sulla TV, in `config.json` aggiungi `"nomi": { "switch.presa": "Presa" }` (oppure usa `{ "id", "nome" }` in `gruppi`).
L'ordine dei gruppi segue `ordineGruppi` in `config.json`; i gruppi non elencati vanno in ordine alfabetico, *Altro* per ultimo.
Se in Home Assistant non c'è nessuna etichetta `TV: …`, la dashboard usa i `gruppi` scritti in `config.json`.

### Diagnostica

Canali, ingressi, Home e salvaschermo usano servizi interni di LG che cambiano tra le versioni di webOS. Se qualcosa non risponde:

```bash
./diagnostica.sh
```

Crea `diagnostica.txt` con i servizi presenti sulla TV e gli id delle app usate (durante gli ultimi 45 secondi premi Home e cambia ingresso).

## Anteprima sul PC

```bash
python -m http.server 8765 --directory app
```

Poi apri <http://localhost:8765> (aggiungi `?salvaschermo` per il salvaschermo). Fuori dalla TV i dati di sistema, app, TV, casa e film sono dimostrativi; il meteo è reale.

## File

| File | Contenuto |
|---|---|
| `app/index.html`, `app/style.css` | struttura e stile (1920×1080, due pagine) |
| `app/js/base.js` | impostazioni, servizi Luna, finestre di scelta, navigazione |
| `app/js/meteo.js`, `tv.js`, `film.js`, `controlli.js`, `barra.js` | pagina 1 |
| `app/js/sistema.js`, `casa.js` | pagina 2 |
| `app/js/sfondi.js` | sfondi della dashboard e del salvaschermo (Bing, NASA, foto del NAS) |
| `app/dlna.py` | elenco dei video (e delle foto, per gli sfondi) del server DLNA (gira come root sulla TV) |
| `app/wol.py` | pacchetto Wake-on-LAN per *Accendi PC* (gira come root sulla TV) |
| `app/configura.py`, `app/configura.html` | pagina web di configurazione sulla porta 8095 (server avviato da `servizio.sh`) e `/api/sistema` per il pannello ESP32 |
| `app/js/avvio.js` | orologio, impostazioni, salvaschermo, tasti, avvio |
| `app/servizio.sh` | servizio root: recenti, Home/salvaschermo sostitutivi, Home LG rimossa, accensione, timer |
| `build.py` | icone e pacchetto `.ipk`, senza dipendenze |
| `homelg/` | app *Home LG*: ripristino in un attimo di Home e salvaschermo LG |
| `film/` | app *Film*: libreria DLNA, locandine TMDB, *Continua a guardare* (`traccia.py`) |
| `installa.sh`, `diagnostica.sh` | installazione e diagnostica via SSH |
| `attiva-dashboard.sh`, `ripristina-lg.sh` | dashboard predefinita / ritorno a Home LG (anche se rimossa), dal PC |
| `rimuovi-home-lg.sh` | toglie la Home LG dal sistema ("solo dashboard"), dal PC |
| `revoca-accesso.sh` | toglie l'accesso SSH dedicato alla TV (chiave `dashboard-tv`) |

## Licenza

[PolyForm Noncommercial 1.0.0](LICENSE.md): uso, modifica e ridistribuzione consentiti solo per scopi non commerciali.
