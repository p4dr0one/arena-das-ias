#!/usr/bin/env python3
"""
Gera imagens de compartilhamento (1200x630) da Arena das IAs.

  python tools/og.py --marca                 -> docs/og.png (imagem fixa da marca, usada pelo site)
  python tools/og.py https://site-da-arena   -> docs/og-placar.png (placar atual, lido de /data/state.json)
  python tools/og.py caminho/state.json      -> idem, a partir de um arquivo local

Precisa de Pillow (pip install pillow).
"""
from __future__ import annotations

import json
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
FONTS = ROOT / "tools" / "fonts"
SP = timezone(timedelta(hours=-3))

BOARD = (22, 48, 90)
BULB = (243, 235, 220)
DIM = (243, 235, 220, 150)
AMBER = (255, 181, 71)
UP = (127, 227, 181)
DOWN = (255, 138, 128)
W, H = 1200, 630


def brl(v: float) -> str:
    s = f"{v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return f"R$ {s}"


def pct(v: float) -> str:
    return f"{v:+.2f}%".replace(".", ",")


def hexrgb(h: str) -> tuple:
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def fonte(tam: int, negrito: bool = True):
    from PIL import ImageFont
    nome = "BigShouldersDisplay-Black.ttf" if negrito else "BigShouldersDisplay-Medium.ttf"
    candidatos = [FONTS / nome, Path("C:/Windows/Fonts/arialbd.ttf" if negrito else "C:/Windows/Fonts/arial.ttf")]
    for c in candidatos:
        if c.exists():
            return ImageFont.truetype(str(c), tam)
    return ImageFont.load_default()


def base():
    from PIL import Image, ImageDraw
    im = Image.new("RGB", (W, H), BOARD)
    d = ImageDraw.Draw(im, "RGBA")
    d.text((56, 42), "ARENA DAS IAS", font=fonte(40), fill=AMBER)
    return im, d


def marca(destino: Path) -> None:
    im, d = base()
    d.text((56, 110), "Qual IA ganha", font=fonte(120), fill=BULB)
    d.text((56, 218), "mais dinheiro", font=fonte(120), fill=BULB)
    d.text((56, 326), "na cripto?", font=fonte(120), fill=BULB)
    # três barras do placar, como no ícone
    for i, (cor, alt) in enumerate(((DOWN, 90), (AMBER, 170), (UP, 270))):
        x = 930 + i * 78
        d.rectangle((x, 420 - alt, x + 54, 420), fill=cor)
    d.text((56, 480), "Sete IAs. R$ 10 mil simulados cada. Nova decisão a cada 30 minutos,", font=fonte(30, False), fill=BULB)
    d.text((56, 518), "com o raciocínio de cada uma em português. Ao vivo.", font=fonte(30, False), fill=BULB)
    d.text((56, H - 56), "Dinheiro simulado. Não é recomendação de investimento.", font=fonte(22, False), fill=DIM)
    im.save(destino, "PNG", optimize=True)


def placar(estado: dict, destino: Path) -> None:
    im, d = base()
    quando = estado.get("atualizado_em")
    hora = datetime.fromisoformat(quando).astimezone(SP).strftime("%d/%m %H:%M") if quando else ""
    d.text((W - 56, 50), f"placar de {hora}", font=fonte(24, False), fill=DIM, anchor="ra")
    d.text((56, 96), "Qual IA ganha mais dinheiro na cripto?", font=fonte(54), fill=BULB)
    d.line((56, 170, W - 56, 170), fill=(243, 235, 220, 70), width=2)
    ag = [a for a in estado.get("agentes", []) if a.get("status") != "sem_chave"]
    ag.sort(key=lambda a: -a["patrimonio"])
    if not ag:
        d.text((56, 200), "A primeira IA ainda não entrou na arena.", font=fonte(34, False), fill=DIM)
    y = 184
    for i, a in enumerate(ag[:6], 1):
        cor = hexrgb(a.get("cor", "#999999"))
        d.rectangle((56, y + 4, 64, y + 52), fill=cor)
        d.text((82, y), f"{i}", font=fonte(42), fill=AMBER if i == 1 else DIM)
        d.text((130, y), a["nome"], font=fonte(42), fill=BULB)
        d.text((130, y + 44), a.get("empresa", ""), font=fonte(18, False), fill=DIM)
        r = a.get("retorno_pct", 0.0)
        d.text((W - 56, y), pct(r), font=fonte(42), fill=UP if r > 0.005 else DOWN if r < -0.005 else DIM, anchor="ra")
        d.text((W - 230, y), brl(a["patrimonio"]), font=fonte(42), fill=AMBER if i == 1 else BULB, anchor="ra")
        y += 64
    hodl = estado.get("hodl") or {}
    if hodl.get("retorno_pct") is not None:
        rodape = f"Comprar bitcoin e ficar quieto: {pct(hodl['retorno_pct'])}   |   dinheiro simulado, decisões reais das IAs"
    else:
        rodape = "R$ 10 mil simulados por IA. Decisões reais, a cada 30 minutos."
    d.text((56, H - 56), rodape, font=fonte(22, False), fill=DIM)
    im.save(destino, "PNG", optimize=True)


def carregar_estado(origem: str) -> dict:
    if origem.startswith("http://") or origem.startswith("https://"):
        url = origem.rstrip("/") + "/data/state.json"
        req = urllib.request.Request(url, headers={"User-Agent": "arena-das-ias/og"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))
    return json.loads(Path(origem).read_text(encoding="utf-8"))


def main(argv: list[str]) -> int:
    try:
        import PIL  # noqa: F401
    except ImportError:
        print("Pillow não instalado: pip install pillow")
        return 1
    if not argv or argv[0] == "--marca":
        destino = DOCS / "og.png"
        marca(destino)
        print(f"gerado {destino}")
        return 0
    estado = carregar_estado(argv[0])
    destino = Path(argv[1]) if len(argv) > 1 else DOCS / "og-placar.png"
    placar(estado, destino)
    print(f"gerado {destino}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
