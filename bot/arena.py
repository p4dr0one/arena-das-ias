#!/usr/bin/env python3
"""
Arena das IAs — motor de uma rodada.

Cada rodada: busca preços no Mercado Bitcoin, pede uma decisão a cada agente
(modelos de IA de provedores diferentes), aplica a decisão numa carteira
SIMULADA (dinheiro fictício, taxa de 0,7% por operação, sem alavancagem,
sem venda a descoberto) e grava tudo em docs/data/ para o site ler.

Só usa a biblioteca padrão do Python. Sem pip.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("ARENA_DATA_DIR") or (ROOT / "docs" / "data"))
MOCK = os.environ.get("ARENA_MOCK") == "1"

MB = "https://api.mercadobitcoin.net/api/v4"
ATIVOS = ["BTC", "ETH", "SOL"]
CAPITAL_INICIAL = 10_000.0
TAXA = 0.007            # taxa taker do Mercado Bitcoin na faixa inicial
INTERVALO_MIN = 30      # cadência do cron
TRADE_MINIMO = 50.0     # abaixo disso, vira "manter"
DURACAO_TEMPORADA_DIAS = 14
SP = timezone(timedelta(hours=-3), "America/Sao_Paulo")
UA = "arena-das-ias/0.1 (+https://github.com/p4dr0one/arena-das-ias)"

# ---------------------------------------------------------------- agentes --
# Cada agente é um modelo de IA real, de um provedor diferente. Sem chave, o
# agente fica "sem_chave" e não opera. Nenhuma decisão é inventada.
AGENTES = [
    {
        "id": "gpt-oss-120b",
        "nome": "GPT-OSS 120B",
        "empresa": "OpenAI (pesos abertos)",
        "modelo": "openai/gpt-oss-120b",
        "provedor": "groq",
        "cor": "#f5a524",
        "descricao": "O maior modelo aberto da OpenAI, rodando nos chips da Groq.",
        "cadencia_min": 30,
        "extra": {"reasoning_effort": "low"},
    },
    {
        "id": "qwen-3-8-27b",
        "nome": "Qwen 3.8 27B",
        "empresa": "Alibaba",
        "modelo": "qwen/qwen3.8-27b",
        "provedor": "groq",
        "cor": "#7c5cff",
        "descricao": "O modelo da Alibaba. Um Qwen venceu a primeira arena americana em 2025.",
        "cadencia_min": 30,
        "extra": {},
    },
    {
        "id": "gpt-oss-20b",
        "nome": "GPT-OSS 20B",
        "empresa": "OpenAI (pesos abertos)",
        "modelo": "openai/gpt-oss-20b",
        "provedor": "groq",
        "cor": "#ff6b6b",
        "descricao": "O irmão menor do 120B. Mais rápido, menos neurônios.",
        "cadencia_min": 30,
        "extra": {"reasoning_effort": "low"},
    },
    {
        "id": "gemini-flash-lite",
        "nome": "Gemini Flash-Lite",
        "empresa": "Google",
        "modelo": os.environ.get("GEMINI_MODEL", "gemini-2.5-flash-lite"),
        "provedor": "gemini",
        "cor": "#3ddc97",
        "descricao": "O modelo leve do Google, direto do Google AI Studio.",
        "cadencia_min": 30,
        "extra": {},
    },
    {
        "id": "openrouter-free",
        "nome": os.environ.get("OPENROUTER_NOME", "Nemotron 3 Super"),
        "empresa": os.environ.get("OPENROUTER_EMPRESA", "NVIDIA"),
        "modelo": os.environ.get("OPENROUTER_MODEL", "nvidia/nemotron-3-super-120b-a12b:free"),
        "provedor": "openrouter",
        "cor": "#4cc9f0",
        "descricao": "O modelo da NVIDIA. Decide uma vez por hora, porque a cota gratuita é menor.",
        "cadencia_min": 60,
        "extra": {},
    },
    {
        "id": "llama-cloudflare",
        "nome": os.environ.get("CF_NOME", "Llama 3.3 70B"),
        "empresa": "Meta",
        "modelo": os.environ.get("CF_MODEL", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
        "provedor": "cloudflare",
        "cor": "#ff9ff3",
        "descricao": "O modelo da Meta, rodando na borda da Cloudflare.",
        "cadencia_min": 30,
        "extra": {},
    },
]

PROVEDORES = {
    "groq": {
        "url": "https://api.groq.com/openai/v1/chat/completions",
        "env": "GROQ_API_KEY",
        "json_mode": True,
    },
    "gemini": {
        "url": "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        "env": "GEMINI_API_KEY",
        "json_mode": True,
    },
    "openrouter": {
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "env": "OPENROUTER_API_KEY",
        "json_mode": False,
        "headers": {
            "HTTP-Referer": "https://github.com/p4dr0one/arena-das-ias",
            "X-Title": "Arena das IAs",
        },
    },
    "cloudflare": {
        "url": "https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/ai/v1/chat/completions",
        "env": "CF_API_TOKEN",
        "json_mode": False,
    },
}


# ------------------------------------------------------------------ utils --
def agora() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def parse_iso(s: str | None) -> datetime | None:
    return datetime.fromisoformat(s) if s else None


def log(msg: str) -> None:
    print(f"[{agora().astimezone(SP).strftime('%H:%M:%S')}] {msg}", flush=True)


def http_json(url: str, data: dict | None = None, headers: dict | None = None, timeout: int = 60):
    body = json.dumps(data).encode("utf-8") if data is not None else None
    req = urllib.request.Request(url, data=body, method="POST" if body else "GET")
    req.add_header("User-Agent", UA)
    req.add_header("Accept", "application/json")
    if body:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def brl(v: float) -> str:
    s = f"{v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return f"R$ {s}"


def pct(v: float) -> str:
    return f"{v:+.2f}%".replace(".", ",")


# ---------------------------------------------------------------- mercado --
def buscar_mercado() -> dict:
    """Preços atuais + velas de 1h (24) e 1d (7) por ativo, do Mercado Bitcoin."""
    if MOCK:
        return _mercado_mock()
    simbolos = ",".join(f"{a}-BRL" for a in ATIVOS)
    tickers = http_json(f"{MB}/tickers?symbols={simbolos}")
    now = int(time.time())
    mercado = {}
    for t in tickers:
        a = t["pair"].split("-")[0]
        last, open_ = float(t["last"]), float(t["open"])
        mercado[a] = {
            "last": last,
            "buy": float(t["buy"]),    # melhor oferta de compra (quem vende recebe isso)
            "sell": float(t["sell"]),  # melhor oferta de venda (quem compra paga isso)
            "high": float(t["high"]),
            "low": float(t["low"]),
            "vol": float(t["vol"]),
            "var_24h": (last / open_ - 1) * 100 if open_ else 0.0,
        }
    for a in ATIVOS:
        h = http_json(f"{MB}/candles?symbol={a}-BRL&resolution=1h&to={now}&countback=24")
        d = http_json(f"{MB}/candles?symbol={a}-BRL&resolution=1d&to={now}&countback=7")
        mercado[a]["h1"] = [round(float(c)) for c in h.get("c", [])]
        mercado[a]["d1"] = [round(float(c)) for c in d.get("c", [])]
        time.sleep(0.3)
    return mercado


def _mercado_mock() -> dict:
    base = {"BTC": 421_000.0, "ETH": 12_780.0, "SOL": 561.0}
    seed = int(time.time() // 1800)
    m = {}
    for a, p in base.items():
        wobble = ((seed * 7 + len(a)) % 13 - 6) / 1000
        last = p * (1 + wobble)
        m[a] = {
            "last": last, "buy": last * 0.9995, "sell": last * 1.0005,
            "high": last * 1.01, "low": last * 0.99, "vol": 10.0, "var_24h": wobble * 100,
            "h1": [round(last * (1 + ((i * 31 + seed) % 11 - 5) / 1000)) for i in range(24)],
            "d1": [round(last * (1 + ((i * 17 + seed) % 9 - 4) / 100)) for i in range(7)],
        }
    return m


def resumo_mercado(m: dict, quando: datetime) -> str:
    hora = quando.astimezone(SP).strftime("%d/%m %H:%M")
    linhas = [f"Mercado agora (Mercado Bitcoin, preços em reais), {hora} horário de Brasília:"]
    for a in ATIVOS:
        x = m[a]
        h1 = x["h1"]
        var_1h = (h1[-1] / h1[-2] - 1) * 100 if len(h1) >= 2 else 0.0
        d1 = x["d1"]
        var_7d = (d1[-1] / d1[0] - 1) * 100 if len(d1) >= 2 else 0.0
        spread = (x["sell"] / x["buy"] - 1) * 100 if x["buy"] else 0.0
        linhas.append(
            f"{a}: {x['last']:.0f} | 1h {var_1h:+.2f}% | 24h {x['var_24h']:+.2f}% | 7d {var_7d:+.2f}% "
            f"| máx 24h {x['high']:.0f} | mín 24h {x['low']:.0f} | spread {spread:.2f}%"
        )
    for a in ATIVOS:
        serie = ", ".join(str(v) for v in m[a]["h1"])
        linhas.append(f"Fechamentos de 1h do {a} (24 velas, da mais antiga à atual): {serie}")
    for a in ATIVOS:
        serie = ", ".join(str(v) for v in m[a]["d1"])
        linhas.append(f"Fechamentos diários do {a} (7 dias): {serie}")
    return "\n".join(linhas)


# ----------------------------------------------------------------- estado --
def carregar_estado() -> dict:
    p = DATA_DIR / "state.json"
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return {
        "versao": 1,
        "rodada": 0,
        "atualizado_em": None,
        "temporada": {
            "numero": 0,
            "nome": "Temporada 0",
            "status": "aguardando",
            "inicio": None,
            "fim_previsto": None,
            "capital_inicial": CAPITAL_INICIAL,
            "taxa": TAXA,
            "intervalo_min": INTERVALO_MIN,
            "ativos": ATIVOS,
        },
        "precos": {},
        "agentes": [],
        "hodl": None,
        "proxima_rodada_estimada": None,
    }


def carregar_lista(nome: str) -> list:
    p = DATA_DIR / nome
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else []


def salvar(nome: str, obj) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    texto = json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n"
    (DATA_DIR / nome).write_text(texto, encoding="utf-8")


def agente_novo(cfg: dict) -> dict:
    return {
        "id": cfg["id"], "nome": cfg["nome"], "empresa": cfg["empresa"], "modelo": cfg["modelo"],
        "provedor": cfg["provedor"], "cor": cfg["cor"], "descricao": cfg["descricao"],
        "cadencia_min": cfg["cadencia_min"],
        "status": "sem_chave", "entrou_na_rodada": None, "entrou_em": None,
        "caixa": CAPITAL_INICIAL, "posicoes": {a: 0.0 for a in ATIVOS},
        "patrimonio": CAPITAL_INICIAL, "retorno_pct": 0.0, "n_trades": 0, "n_decisoes": 0,
        "ultima_decisao": None, "ultimo_erro": None,
    }


def patrimonio(ag: dict, m: dict) -> float:
    return ag["caixa"] + sum(ag["posicoes"].get(a, 0.0) * m[a]["buy"] for a in ATIVOS)


# ------------------------------------------------------------------ prompt --
SISTEMA = """Você é {nome}, um agente de IA que opera numa arena pública chamada Arena das IAs.
Você compete contra outros modelos de IA. Todo mundo vê suas decisões e seu raciocínio.

Regras da arena:
- Dinheiro SIMULADO: cada agente começou com R$ 10.000. Vence quem tiver maior patrimônio no fim da temporada.
- Mercado à vista no Mercado Bitcoin: BTC, ETH e SOL contra reais. Sem alavancagem, sem venda a descoberto, sem derivativos.
- Toda operação paga 0,7% de taxa. Operar demais destrói patrimônio. Ficar parado é uma decisão válida.
- Você compra pelo preço de venda do livro (sell) e vende pelo preço de compra (buy).
- Uma decisão por rodada. A próxima rodada é em {cadencia} minutos.

Responda SOMENTE com um objeto JSON, sem texto antes ou depois, neste formato:
{{"acao": "comprar" | "vender" | "manter", "ativo": "BTC" | "ETH" | "SOL", "fracao": número entre 0 e 1, "raciocinio": "texto"}}
- "fracao": em "comprar", a fração do seu CAIXA que você gasta; em "vender", a fração da sua POSIÇÃO naquele ativo que você vende; em "manter", 0.
- "raciocinio": no máximo 280 caracteres, em português do Brasil, falando direto com o público da arena. Sem jargão vazio. Diga o que você viu nos dados e por que decidiu isso."""


def prompt_usuario(ag: dict, m: dict, quando: datetime, ranking: list, decisoes_prev: list) -> str:
    partes = []
    for a in ATIVOS:
        if ag["posicoes"][a] > 0:
            partes.append(f"{a} {ag['posicoes'][a]:.6f} ({brl(ag['posicoes'][a] * m[a]['buy'])})")
    pos = " | ".join(partes) or "nenhuma posição"
    ret = (patrimonio(ag, m) / CAPITAL_INICIAL - 1) * 100
    rk_partes = []
    for i, (n, r) in enumerate(ranking):
        rk_partes.append(f"{i + 1}º {n} {pct(r)}" + (" (você)" if n == ag["nome"] else ""))
    rk = "; ".join(rk_partes) or "ainda sem ranking"
    ult_partes = []
    for d in decisoes_prev[-3:]:
        hora = parse_iso(d["t"]).astimezone(SP).strftime("%d/%m %H:%M")
        fr = int(round(d.get("fracao", 0) * 100))
        ult_partes.append(f"- {hora}: {d['acao']} {d.get('ativo') or ''} {fr}% — \"{d['raciocinio']}\"")
    ult = "\n".join(ult_partes) or "- nenhuma ainda (esta é sua primeira rodada)"
    return (
        f"{resumo_mercado(m, quando)}\n\n"
        f"Sua carteira: caixa {brl(ag['caixa'])} | {pos} | patrimônio {brl(patrimonio(ag, m))} "
        f"({pct(ret)} na temporada) | {ag['n_trades']} operações feitas\n"
        f"Suas últimas decisões:\n{ult}\n"
        f"Ranking atual da arena: {rk}\n\n"
        f"Decida agora. Responda só o JSON."
    )


# --------------------------------------------------------------- chamadas --
class ErroProvedor(Exception):
    pass


def chamar_modelo(cfg: dict, sistema: str, usuario: str) -> tuple:
    """Devolve (texto_da_resposta, meta). Levanta ErroProvedor em falha definitiva."""
    if MOCK:
        return _mock_resposta(cfg, usuario), {"mock": True}
    prov = PROVEDORES[cfg["provedor"]]
    chave = os.environ.get(prov["env"], "").strip()
    if not chave:
        raise ErroProvedor("sem_chave")
    url = prov["url"]
    if "{CF_ACCOUNT_ID}" in url:
        acct = os.environ.get("CF_ACCOUNT_ID", "").strip()
        if not acct:
            raise ErroProvedor("sem_chave")
        url = url.replace("{CF_ACCOUNT_ID}", acct)
    headers = {"Authorization": f"Bearer {chave}", **prov.get("headers", {})}
    corpo = {
        "model": cfg["modelo"],
        "messages": [{"role": "system", "content": sistema}, {"role": "user", "content": usuario}],
        "temperature": 0.7,
        "max_tokens": 1200,
    }
    corpo.update(cfg.get("extra", {}))
    if prov["json_mode"]:
        tentativas = [dict(corpo, response_format={"type": "json_object"}), corpo]
    else:
        tentativas = [corpo]
    ultimo = "erro desconhecido"
    for i, c in enumerate(tentativas):
        for tentativa in range(2):
            try:
                t0 = time.time()
                resp = http_json(url, c, headers)
                dur = time.time() - t0
                msg = (resp.get("choices") or [{}])[0].get("message") or {}
                texto = msg.get("content") or ""
                if not texto and isinstance(msg.get("reasoning"), str):
                    texto = msg["reasoning"]
                uso = resp.get("usage") or {}
                return texto, {"segundos": round(dur, 1), "tokens": uso.get("total_tokens")}
            except urllib.error.HTTPError as e:
                detalhe = e.read().decode("utf-8", "replace")[:300]
                ultimo = f"HTTP {e.code}: {detalhe}"
                if e.code == 400 and i == 0 and len(tentativas) > 1:
                    break  # tenta sem json_mode
                if e.code in (429, 500, 502, 503, 504) and tentativa == 0:
                    espera = 20
                    ra = e.headers.get("Retry-After") if e.headers else None
                    if ra and ra.isdigit():
                        espera = min(int(ra), 60)
                    log(f"  {cfg['nome']}: {ultimo[:80]} — esperando {espera}s")
                    time.sleep(espera)
                    continue
                if e.code == 429:
                    raise ErroProvedor("limite_atingido: " + ultimo)
                if e.code in (401, 403):
                    raise ErroProvedor("chave_invalida: " + ultimo)
                raise ErroProvedor(ultimo)
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                ultimo = f"rede: {e}"
                if tentativa == 0:
                    time.sleep(10)
                    continue
                raise ErroProvedor(ultimo)
    raise ErroProvedor(ultimo)


def _mock_resposta(cfg: dict, usuario: str) -> str:
    h = int(hashlib.sha256((cfg["id"] + usuario[:120]).encode()).hexdigest(), 16)
    acao = ["comprar", "vender", "manter", "comprar"][h % 4]
    ativo = ATIVOS[h % 3]
    fracao = [0.25, 0.5, 0.1, 1.0][(h >> 8) % 4] if acao != "manter" else 0
    return json.dumps({
        "acao": acao, "ativo": ativo, "fracao": fracao,
        "raciocinio": f"[TESTE LOCAL, decisão falsa] {cfg['nome']} escolheu {acao} {ativo}.",
    }, ensure_ascii=False)


def extrair_json(texto: str):
    """Acha o primeiro objeto JSON com "acao" dentro de uma resposta livre."""
    texto = re.sub(r"<think>.*?</think>", " ", texto, flags=re.S | re.I)
    texto = re.sub(r"```(?:json)?", " ", texto, flags=re.I).strip()
    dec = json.JSONDecoder()
    for m in re.finditer(r"\{", texto):
        try:
            obj, _ = dec.raw_decode(texto, m.start())
        except ValueError:
            continue
        if isinstance(obj, dict) and "acao" in obj:
            return obj
    return None


def normalizar_decisao(obj):
    if not isinstance(obj, dict):
        return None
    acao = str(obj.get("acao", "")).strip().lower()
    if acao not in ("comprar", "vender", "manter"):
        return None
    ativo = str(obj.get("ativo", "")).strip().upper()
    if acao != "manter" and ativo not in ATIVOS:
        return None
    try:
        fracao = float(obj.get("fracao", 0) or 0)
    except (TypeError, ValueError):
        fracao = 0.0
    fracao = max(0.0, min(1.0, fracao))
    rac = str(obj.get("raciocinio", "")).strip().replace("\n", " ")
    if len(rac) > 400:
        rac = rac[:397] + "..."
    return {
        "acao": acao,
        "ativo": ativo if acao != "manter" else None,
        "fracao": fracao if acao != "manter" else 0.0,
        "raciocinio": rac or "(sem explicação)",
    }


# ---------------------------------------------------------------- carteira --
def aplicar(ag: dict, dec: dict, m: dict) -> dict:
    """Aplica a decisão na carteira simulada. Devolve detalhes da execução."""
    acao, ativo, fr = dec["acao"], dec["ativo"], dec["fracao"]
    if acao == "comprar":
        gasto = ag["caixa"] * fr
        preco = m[ativo]["sell"]
        if gasto < TRADE_MINIMO:
            return {"executada": False, "motivo": "valor abaixo do mínimo de R$ 50", "valor": 0.0, "preco": preco}
        qtd = gasto * (1 - TAXA) / preco
        ag["caixa"] -= gasto
        ag["posicoes"][ativo] += qtd
        ag["n_trades"] += 1
        return {"executada": True, "valor": gasto, "preco": preco, "quantidade": qtd, "taxa": gasto * TAXA}
    if acao == "vender":
        qtd = ag["posicoes"][ativo] * fr
        preco = m[ativo]["buy"]
        bruto = qtd * preco
        if bruto < TRADE_MINIMO:
            motivo = "não tinha posição suficiente" if ag["posicoes"][ativo] <= 0 else "valor abaixo do mínimo de R$ 50"
            return {"executada": False, "motivo": motivo, "valor": 0.0, "preco": preco}
        ag["posicoes"][ativo] -= qtd
        if ag["posicoes"][ativo] < 1e-9:
            ag["posicoes"][ativo] = 0.0
        liquido = bruto * (1 - TAXA)
        ag["caixa"] += liquido
        ag["n_trades"] += 1
        return {"executada": True, "valor": bruto, "preco": preco, "quantidade": qtd, "taxa": bruto * TAXA}
    return {"executada": True, "valor": 0.0, "preco": None}


# ------------------------------------------------------------------- main --
def main() -> int:
    quando = agora()
    estado = carregar_estado()
    historico = carregar_lista("historico.json")
    decisoes = carregar_lista("decisoes.json")
    temporada = estado["temporada"]

    log(f"Rodada {estado['rodada'] + 1} — buscando mercado{' (MOCK)' if MOCK else ''}")
    try:
        m = buscar_mercado()
    except Exception as e:
        log(f"Falha ao buscar mercado: {e}")
        return 1
    estado["rodada"] += 1
    n = estado["rodada"]

    # sincroniza lista de agentes com a configuração (novos entram zerados)
    por_id = {a["id"]: a for a in estado["agentes"]}
    agentes = []
    for cfg in AGENTES:
        ag = por_id.get(cfg["id"]) or agente_novo(cfg)
        for k in ("nome", "empresa", "modelo", "cor", "descricao", "cadencia_min", "provedor"):
            ag[k] = cfg[k]
        ag.setdefault("posicoes", {a: 0.0 for a in ATIVOS})
        for a in ATIVOS:
            ag["posicoes"].setdefault(a, 0.0)
        agentes.append((cfg, ag))
    estado["agentes"] = [ag for _, ag in agentes]

    ranking_prev = sorted(
        (
            (ag["nome"], (patrimonio(ag, m) / CAPITAL_INICIAL - 1) * 100)
            for _, ag in agentes
            if ag["status"] in ("ativo", "erro", "limite")
        ),
        key=lambda x: -x[1],
    )

    alguem_ativo = False
    for cfg, ag in agentes:
        prov = PROVEDORES[cfg["provedor"]]
        tem_chave = MOCK or bool(os.environ.get(prov["env"], "").strip())
        if cfg["provedor"] == "cloudflare" and not MOCK:
            tem_chave = tem_chave and bool(os.environ.get("CF_ACCOUNT_ID", "").strip())
        if not tem_chave:
            ag["status"] = "sem_chave"
            ag["patrimonio"] = round(patrimonio(ag, m), 2)
            ag["retorno_pct"] = round((ag["patrimonio"] / CAPITAL_INICIAL - 1) * 100, 3)
            continue
        if ag["entrou_na_rodada"] is None:
            ag["entrou_na_rodada"], ag["entrou_em"] = n, iso(quando)
        passo = max(1, cfg["cadencia_min"] // INTERVALO_MIN)
        if (n - ag["entrou_na_rodada"]) % passo != 0:
            alguem_ativo = True
            ag["patrimonio"] = round(patrimonio(ag, m), 2)
            ag["retorno_pct"] = round((ag["patrimonio"] / CAPITAL_INICIAL - 1) * 100, 3)
            log(f"{ag['nome']}: fora da cadência nesta rodada")
            continue

        prev = [d for d in decisoes if d["agente"] == ag["id"]]
        sistema = SISTEMA.format(nome=ag["nome"], cadencia=cfg["cadencia_min"])
        usuario = prompt_usuario(ag, m, quando, ranking_prev, prev)
        registro = {"t": iso(quando), "n": n, "agente": ag["id"], "nome": ag["nome"]}
        try:
            texto, meta = chamar_modelo(cfg, sistema, usuario)
            dec = normalizar_decisao(extrair_json(texto))
            if dec is None:
                dec = {"acao": "manter", "ativo": None, "fracao": 0.0,
                       "raciocinio": "Resposta fora do formato. A arena registrou como manter."}
                registro["resposta_invalida"] = texto[:200]
            exe = aplicar(ag, dec, m)
            ag["status"] = "ativo"
            ag["ultimo_erro"] = None
            alguem_ativo = True
            registro.update(dec)
            registro.update({
                "executada": exe["executada"], "valor": round(exe.get("valor", 0.0), 2),
                "preco": exe.get("preco"), "motivo": exe.get("motivo"),
            })
            registro["meta"] = meta
            log(f"{ag['nome']}: {dec['acao']} {dec['ativo'] or ''} {int(dec['fracao'] * 100)}% — {dec['raciocinio'][:90]}")
        except ErroProvedor as e:
            msg = str(e)
            if msg.startswith("limite_atingido"):
                ag["status"] = "limite"
            elif msg == "sem_chave":
                ag["status"] = "sem_chave"
            else:
                ag["status"] = "erro"
            ag["ultimo_erro"] = msg[:200]
            alguem_ativo = alguem_ativo or ag["status"] != "sem_chave"
            registro.update({
                "acao": "manter", "ativo": None, "fracao": 0.0,
                "raciocinio": "Sem resposta do provedor nesta rodada. A arena registrou como manter.",
                "executada": False, "valor": 0.0, "preco": None, "erro": msg[:200],
            })
            log(f"{ag['nome']}: ERRO {msg[:120]}")
        ag["n_decisoes"] += 1
        ag["patrimonio"] = round(patrimonio(ag, m), 2)
        ag["retorno_pct"] = round((ag["patrimonio"] / CAPITAL_INICIAL - 1) * 100, 3)
        registro["patrimonio_apos"] = ag["patrimonio"]
        campos = ("t", "n", "acao", "ativo", "fracao", "raciocinio", "executada", "valor", "preco", "motivo")
        ag["ultima_decisao"] = {k: registro.get(k) for k in campos}
        decisoes.append(registro)

    # temporada começa na primeira rodada com alguém ativo
    if alguem_ativo and temporada["status"] == "aguardando":
        temporada["status"] = "em_andamento"
        temporada["inicio"] = iso(quando)
        temporada["fim_previsto"] = iso(quando + timedelta(days=DURACAO_TEMPORADA_DIAS))
        estado["hodl"] = {"btc": CAPITAL_INICIAL * (1 - TAXA) / m["BTC"]["sell"], "preco_entrada": m["BTC"]["sell"]}
        log("Temporada 0 começou.")
    fim_prev = parse_iso(temporada.get("fim_previsto"))
    if temporada["status"] == "em_andamento" and fim_prev and quando >= fim_prev:
        temporada["status"] = "encerrada"
        temporada["fim"] = iso(quando)
        log("Temporada encerrada.")

    hodl = None
    if estado.get("hodl"):
        v = estado["hodl"]["btc"] * m["BTC"]["buy"]
        hodl = {"patrimonio": round(v, 2), "retorno_pct": round((v / CAPITAL_INICIAL - 1) * 100, 3),
                "preco_entrada": estado["hodl"]["preco_entrada"]}
        estado["hodl"].update(hodl)

    estado["precos"] = {
        a: {k: (round(v, 2) if isinstance(v, float) else v) for k, v in m[a].items() if k not in ("h1", "d1")}
        for a in ATIVOS
    }
    estado["atualizado_em"] = iso(quando)
    estado["proxima_rodada_estimada"] = iso(quando + timedelta(minutes=INTERVALO_MIN))
    estado["agentes"].sort(key=lambda a: (a["status"] == "sem_chave", -a["patrimonio"]))

    historico.append({
        "t": iso(quando), "n": n,
        "p": {a: round(m[a]["last"], 2) for a in ATIVOS},
        "e": {ag["id"]: ag["patrimonio"] for _, ag in agentes if ag["status"] != "sem_chave"},
        "hodl": hodl["patrimonio"] if hodl else None,
    })
    historico = historico[-3000:]
    decisoes = decisoes[-400:]

    salvar("state.json", estado)
    salvar("historico.json", historico)
    salvar("decisoes.json", decisoes)
    log("Dados salvos em " + str(DATA_DIR))
    for _, ag in agentes:
        log(f"  {ag['nome']:<18} {ag['status']:<9} {brl(ag['patrimonio'])} ({pct(ag['retorno_pct'])})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
