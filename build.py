"""Crea le icone e i pacchetti .ipk, senza dipendenze esterne:
 - la dashboard (cartella app/)
 - "Home LG" (cartella homelg/), che riporta in un attimo Home, accensione e salvaschermo a quelli LG
 - "Film" (cartella film/), la libreria del server DLNA con locandine e "Continua a guardare"

Uso:  python build.py
Output: dist/<id>_<versione>_all.ipk per ciascuna app, dist/build.txt (marcatore della build della dashboard)
"""

import io
import json
import struct
import tarfile
import time
import zlib
from pathlib import Path

RADICE = Path(__file__).resolve().parent
APP = RADICE / "app"
HOMELG = RADICE / "homelg"
FILM = RADICE / "film"
DIST = RADICE / "dist"


# ---------- Icone (PNG disegnato a mano, con supercampionamento) ----------

def _png(larghezza, altezza, pixel):
    def chunk(tipo, dati):
        return struct.pack(">I", len(dati)) + tipo + dati + struct.pack(">I", zlib.crc32(tipo + dati) & 0xFFFFFFFF)

    righe = b"".join(b"\x00" + bytes(pixel[y * larghezza * 4:(y + 1) * larghezza * 4]) for y in range(altezza))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", larghezza, altezza, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(righe, 9))
            + chunk(b"IEND", b""))


def _dentro_rettangolo_arrotondato(x, y, x0, y0, x1, y1, r):
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def disegna_icona(n):
    ss = 4
    pixel = bytearray(n * n * 4)
    # Quattro riquadri 2x2: il primo in evidenza
    margine, spazio = 0.24, 0.06
    lato = (1 - 2 * margine - spazio) / 2
    riquadri = []
    for riga in range(2):
        for col in range(2):
            x0 = margine + col * (lato + spazio)
            y0 = margine + riga * (lato + spazio)
            riquadri.append((x0, y0, x0 + lato, y0 + lato))
    for py in range(n):
        for px in range(n):
            somma = [0.0, 0.0, 0.0, 0.0]
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) / n
                    y = (py + (sy + 0.5) / ss) / n
                    if not _dentro_rettangolo_arrotondato(x, y, 0, 0, 1, 1, 0.22):
                        continue
                    t = (x + y) / 2
                    colore = (59 + (112 - 59) * t, 91 + (72 - 91) * t, 219 + (232 - 219) * t)
                    for i, q in enumerate(riquadri):
                        if _dentro_rettangolo_arrotondato(x, y, *q, 0.05):
                            alfa = 1.0 if i == 0 else 0.55
                            colore = tuple(c * (1 - alfa) + 255 * alfa for c in colore)
                            break
                    somma[0] += colore[0]
                    somma[1] += colore[1]
                    somma[2] += colore[2]
                    somma[3] += 255
            campioni = ss * ss
            copertura = somma[3] / 255
            i = (py * n + px) * 4
            if copertura:
                pixel[i:i + 3] = bytes(round(c / copertura) for c in somma[:3])
            pixel[i + 3] = round(somma[3] / campioni)
    return _png(n, n, pixel)


def _dentro_triangolo(x, y, a, b, c):
    def lato(p, q, r):
        return (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1])
    d1, d2, d3 = lato((x, y), a, b), lato((x, y), b, c), lato((x, y), c, a)
    return not ((d1 < 0 or d2 < 0 or d3 < 0) and (d1 > 0 or d2 > 0 or d3 > 0))


def disegna_icona_home(n):
    ss = 4
    pixel = bytearray(n * n * 4)
    for py in range(n):
        for px in range(n):
            somma = [0.0, 0.0, 0.0, 0.0]
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) / n
                    y = (py + (sy + 0.5) / ss) / n
                    if not _dentro_rettangolo_arrotondato(x, y, 0, 0, 1, 1, 0.22):
                        continue
                    t = (x + y) / 2
                    colore = (255 + (229 - 255) * t, 159 + (56 - 159) * t, 90 + (59 - 90) * t)
                    tetto = _dentro_triangolo(x, y, (0.5, 0.2), (0.17, 0.5), (0.83, 0.5))
                    corpo = 0.28 <= x <= 0.72 and 0.47 <= y <= 0.78
                    porta = 0.44 <= x <= 0.56 and 0.6 <= y <= 0.78
                    if (tetto or corpo) and not porta:
                        colore = (255, 255, 255)
                    somma[0] += colore[0]
                    somma[1] += colore[1]
                    somma[2] += colore[2]
                    somma[3] += 255
            campioni = ss * ss
            copertura = somma[3] / 255
            i = (py * n + px) * 4
            if copertura:
                pixel[i:i + 3] = bytes(round(c / copertura) for c in somma[:3])
            pixel[i + 3] = round(somma[3] / campioni)
    return _png(n, n, pixel)


def disegna_icona_film(n):
    ss = 4
    pixel = bytearray(n * n * 4)
    for py in range(n):
        for px in range(n):
            somma = [0.0, 0.0, 0.0, 0.0]
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) / n
                    y = (py + (sy + 0.5) / ss) / n
                    if not _dentro_rettangolo_arrotondato(x, y, 0, 0, 1, 1, 0.22):
                        continue
                    t = (x + y) / 2
                    colore = (232 + (150 - 232) * t, 64 + (52 - 64) * t, 92 + (190 - 92) * t)
                    # Locandina stilizzata con il triangolo "play"
                    if _dentro_rettangolo_arrotondato(x, y, 0.27, 0.2, 0.73, 0.8, 0.06):
                        colore = (255, 255, 255)
                        if _dentro_triangolo(x, y, (0.43, 0.38), (0.43, 0.62), (0.62, 0.5)):
                            colore = (214, 60, 120)
                    somma[0] += colore[0]
                    somma[1] += colore[1]
                    somma[2] += colore[2]
                    somma[3] += 255
            campioni = ss * ss
            copertura = somma[3] / 255
            i = (py * n + px) * 4
            if copertura:
                pixel[i:i + 3] = bytes(round(c / copertura) for c in somma[:3])
            pixel[i + 3] = round(somma[3] / campioni)
    return _png(n, n, pixel)


# ---------- Pacchetto IPK (archivio ar con debian-binary, control.tar.gz, data.tar.gz) ----------

def _tar_gz(voci):
    """voci: lista di (percorso, contenuto bytes | None per cartella)."""
    buffer = io.BytesIO()
    adesso = int(time.time())
    with tarfile.open(fileobj=buffer, mode="w:gz", format=tarfile.GNU_FORMAT) as tar:
        for percorso, contenuto in voci:
            info = tarfile.TarInfo(percorso)
            info.mtime = adesso
            info.uid = info.gid = 0
            info.uname = info.gname = "root"
            if contenuto is None:
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                tar.addfile(info)
            else:
                info.mode = 0o644
                info.size = len(contenuto)
                tar.addfile(info, io.BytesIO(contenuto))
    return buffer.getvalue()


def _ar(membri):
    out = bytearray(b"!<arch>\n")
    adesso = int(time.time())
    for nome, dati in membri:
        intestazione = (f"{nome:<16}{adesso:<12}{0:<6}{0:<6}{'100644':<8}{len(dati):<10}`\n").encode("ascii")
        assert len(intestazione) == 60
        out += intestazione + dati
        if len(dati) % 2:
            out += b"\n"
    return bytes(out)


def _cartelle(percorso):
    parti = percorso.strip("./").split("/")[:-1]
    return ["./" + "/".join(parti[:i]) + "/" for i in range(1, len(parti) + 1)]


def costruisci_pacchetto(cartella, disegna, con_config=False, extra=None):
    (cartella / "icon.png").write_bytes(disegna(80))
    (cartella / "largeIcon.png").write_bytes(disegna(130))

    info = json.loads((cartella / "appinfo.json").read_text(encoding="utf-8"))
    app_id, versione = info["id"], info["version"]

    base_app = f"./usr/palm/applications/{app_id}/"
    base_pkg = f"./usr/palm/packages/{app_id}/"
    file_app = sorted(p for p in cartella.rglob("*") if p.is_file())

    packageinfo = {
        "app": app_id,
        "id": app_id,
        "loc_name": info.get("title", app_id),
        "package_format_version": 2,
        "vendor": info.get("vendor", ""),
        "version": versione,
    }

    voci = {}
    for p in file_app:
        voci[base_app + p.relative_to(cartella).as_posix()] = p.read_bytes()
    # File in comune con un'altra app (es. dlna.py della dashboard)
    for nome, sorgente in (extra or {}).items():
        voci[base_app + nome] = sorgente.read_bytes()
    # Configurazione personale (Home Assistant, feed, canali): resta fuori da app/ e dal controllo versione
    config = RADICE / "config.json"
    if con_config and config.is_file():
        json.loads(config.read_text(encoding="utf-8"))  # errore chiaro se il JSON non è valido
        voci[base_app + "config.json"] = config.read_bytes()
    voci[base_pkg + "packageinfo.json"] = json.dumps(packageinfo, indent=2).encode("utf-8")
    # Marcatore usato da installa.sh per capire quando la TV ha finito di installare questa build
    build = time.strftime("%Y%m%d%H%M%S")
    voci[base_app + "build.txt"] = build.encode("ascii")

    cartelle = sorted({c for percorso in voci for c in _cartelle(percorso)}, key=len)
    data = _tar_gz([("./", None)] + [(c, None) for c in cartelle] + sorted(voci.items()))

    dimensione_kb = max(1, sum(len(v) for v in voci.values()) // 1024)
    control = (
        f"Package: {app_id}\n"
        f"Version: {versione}\n"
        "Section: misc\n"
        "Priority: optional\n"
        "Architecture: all\n"
        f"Installed-Size: {dimensione_kb}\n"
        f"Maintainer: {info.get('vendor', 'N/A')} <nobody@example.com>\n"
        f"Description: {info.get('title', app_id)}\n"
        "webOS-Package-Format-Version: 2\n"
        "webOS-Packager-Version: x.y.x\n"
    ).encode("utf-8")
    control_tar = _tar_gz([("./", None), ("./control", control)])

    DIST.mkdir(exist_ok=True)
    destinazione = DIST / f"{app_id}_{versione}_all.ipk"
    destinazione.write_bytes(_ar([
        ("debian-binary", b"2.0\n"),
        ("control.tar.gz", control_tar),
        ("data.tar.gz", data),
    ]))
    print(f"Creato {destinazione} ({destinazione.stat().st_size // 1024} KB)")
    return destinazione, build


def costruisci():
    _, build = costruisci_pacchetto(APP, disegna_icona, con_config=True)
    (DIST / "build.txt").write_text(build, encoding="ascii")
    _, build_homelg = costruisci_pacchetto(HOMELG, disegna_icona_home)
    (DIST / "build-homelg.txt").write_text(build_homelg, encoding="ascii")
    _, build_film = costruisci_pacchetto(FILM, disegna_icona_film, extra={"dlna.py": APP / "dlna.py"})
    (DIST / "build-film.txt").write_text(build_film, encoding="ascii")


if __name__ == "__main__":
    costruisci()
