#!/usr/bin/env python3
"""
Gera docs/og.png (imagem de compartilhamento com o placar atual) e
docs/boletim.txt (texto pronto para postar), a partir de docs/data/state.json.

Precisa de Pillow. Se não tiver, só escreve o boletim e sai sem erro.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("ARENA_DATA_DIR") or (ROOT / "docs" / "data"))
DOCS = DATA_DIR.parent
SP = timezone(timedelta(hours=-3))

BOARD = (22, 48, 90)
BULB = (243, 235, 220)
DIM = (243, 235, 220, 150)
AMBER = (255, 181, 71)
UP = (127, 227, 181)
DOWN = (255, 138, 128)


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
    candidatos = [
        ROOT / "bot" / "fonts" / ("BigShouldersDisplay-Black.ttf" if negrito else "BigShouldersDisplay-Medium.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf" if negrito else "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if negrito else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
        Path("C:/Windows/Fonts/arialbd.ttf" if negrito else "C:/Windows/Fonts/arial.ttf"),
    ]
    for c in candidatos:
        if c.exists():
            return ImageFont.truetype(str(c), tam)
    return ImageFont.load_default()


def boletim(estado: dict) -> str:
    ag = [a for a in estado.get("agentes", []) if a.get("status") != "sem_chave"]
    ag.sort(key=lambda a: -a["patrimonio"])
    t = estado.get("temporada", {})
    quando = estado.get("atualizado_em")
    hora = datetime.fromisoformat(quando).astimezone(SP).strftime("%d/%m %H:%M") if quando else "--"
    linhas = [f"Arena das IAs, placar de {hora}:"]
    for i, a in enumerate(ag, 1):
        linhas.append(f"{i}º {a['nome']} {pct(a['retorno_pct'])}")
    if estado.get("hodl") and estado["hodl"].get("retorno_pct") is not None:
        linhas.append(f"Quem só comprou BTC e ficou quieto: {pct(estado['hodl']['retorno_pct'])}")
    ult = [a for a in ag if a.get("ultima_decisao") and a["ultima_decisao"].get("raciocinio")]
    if ult:
        a = ult[0]
        linhas.append("")
        linhas.append(f"{a['nome']} disse: \"{a['ultima_decisao']['raciocinio']}\"")
    if t.get("status") == "em_andamento" and t.get("inicio"):
        dias = max(1, (datetime.now(timezone.utc) - datetime.fromisoformat(t["inicio"])).days + 1)
        linhas.append("")
        linhas.append(f"Dia {dias} de 14. Dinheiro simulado, decisões reais das IAs, a cada 30 min.")
    return "\n".join(linhas)


def imagem(estado: dict, destino: Path) -> bool:
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        print("Pillow não instalado; og.png não gerado.")
        return False
    W, H = 1200, 630
    im = Image.new("RGB", (W, H), BOARD)
    d = ImageDraw.Draw(im, "RGBA")
    d.text((56, 42), "ARENA DAS IAS", font=fonte(40), fill=AMBER)
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
    if estado.get("hodl") and estado["hodl"].get("retorno_pct") is not None:
        d.text((56, H - 56), f"Comprar bitcoin e ficar quieto: {pct(estado['hodl']['retorno_pct'])}   |   dinheiro simulado, decisões reais das IAs",
               font=fonte(22, False), fill=DIM)
    else:
        d.text((56, H - 56), "R$ 10 mil simulados por IA. Decisões reais, a cada 30 minutos.", font=fonte(22, False), fill=DIM)
    im.save(destino, "PNG", optimize=True)
    return True


def main() -> int:
    p = DATA_DIR / "state.json"
    if not p.exists():
        print("sem state.json; nada a fazer")
        return 0
    estado = json.loads(p.read_text(encoding="utf-8"))
    (DOCS / "boletim.txt").write_text(boletim(estado) + "\n", encoding="utf-8")
    ok = imagem(estado, DOCS / "og.png")
    print("boletim.txt escrito; og.png " + ("gerado" if ok else "não gerado"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
