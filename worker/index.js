/**
 * Arena das IAs — Worker da Cloudflare.
 *
 * A cada 30 minutos (cron) roda uma rodada: busca preços no Mercado Bitcoin,
 * pede uma decisão a cada agente (modelos de IA de provedores diferentes),
 * aplica a decisão numa carteira SIMULADA e grava o resultado no KV.
 * O site estático em docs/ lê /data/state.json, /data/historico.json e
 * /data/decisoes.json, servidos daqui a partir do KV.
 *
 * Dinheiro fictício, taxa de 0,7% por operação, sem alavancagem, sem venda
 * a descoberto. Nenhuma decisão é inventada: sem chave, o agente não opera.
 */

const MB = "https://api.mercadobitcoin.net/api/v4";
const ATIVOS = ["BTC", "ETH", "SOL"];
const CAPITAL_INICIAL = 10000;
const TAXA = 0.007;
const INTERVALO_MIN = 30;
const TRADE_MINIMO = 50;
const DURACAO_TEMPORADA_DIAS = 14;
const MAX_HISTORICO = 800;
const MAX_DECISOES = 250;
const UA = "arena-das-ias/0.2 (+https://github.com/p4dr0one/arena-das-ias)";

function agentes(env) {
  return [
    {
      id: "gpt-oss-120b", nome: "GPT-OSS 120B", empresa: "OpenAI (pesos abertos)",
      modelo: "openai/gpt-oss-120b", provedor: "groq", cor: "#f5a524",
      descricao: "O maior modelo aberto da OpenAI, rodando nos chips da Groq.",
      cadencia_min: 30, extra: { reasoning_effort: "low" },
    },
    {
      id: "qwen-3-8-27b", nome: "Qwen 3.8 27B", empresa: "Alibaba",
      modelo: "qwen/qwen3.8-27b", provedor: "groq", cor: "#7c5cff",
      descricao: "O modelo da Alibaba. Um Qwen venceu a primeira arena americana em 2025.",
      cadencia_min: 30, extra: {},
    },
    {
      id: "gpt-oss-20b", nome: "GPT-OSS 20B", empresa: "OpenAI (pesos abertos)",
      modelo: "openai/gpt-oss-20b", provedor: "groq", cor: "#ff6b6b",
      descricao: "O irmão menor do 120B. Mais rápido, menos neurônios.",
      cadencia_min: 30, extra: { reasoning_effort: "low" },
    },
    {
      id: "gemini-flash-lite", nome: "Gemini Flash-Lite", empresa: "Google",
      modelo: env.GEMINI_MODEL || "gemini-2.5-flash-lite", provedor: "gemini", cor: "#3ddc97",
      descricao: "O modelo leve do Google, direto do Google AI Studio.",
      cadencia_min: 30, extra: {},
    },
    {
      id: "openrouter-free", nome: env.OPENROUTER_NOME || "Nemotron 3 Super", empresa: env.OPENROUTER_EMPRESA || "NVIDIA",
      modelo: env.OPENROUTER_MODEL || "nvidia/nemotron-3-super-120b-a12b:free", provedor: "openrouter", cor: "#4cc9f0",
      descricao: "O modelo da NVIDIA. Decide uma vez por hora, porque a cota gratuita é menor.",
      cadencia_min: 60, extra: {},
    },
    {
      id: "llama-cloudflare", nome: "Llama 3.3 70B", empresa: "Meta",
      modelo: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", provedor: "cloudflare", cor: "#ff9ff3",
      descricao: "O modelo da Meta, rodando na borda da Cloudflare.",
      cadencia_min: 30, extra: {},
    },
    {
      id: "mistral-small", nome: "Mistral Small 3.1", empresa: "Mistral (França)",
      modelo: "@cf/mistralai/mistral-small-3.1-24b-instruct", provedor: "cloudflare", cor: "#ffd166",
      descricao: "O modelo francês, rodando na borda da Cloudflare. Decide uma vez por hora.",
      cadencia_min: 60, extra: {},
    },
  ];
}

const PROVEDORES = {
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", env: "GROQ_API_KEY", json_mode: true },
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", env: "GEMINI_API_KEY", json_mode: true },
  openrouter: {
    url: "https://openrouter.ai/api/v1/chat/completions", env: "OPENROUTER_API_KEY", json_mode: false,
    headers: { "HTTP-Referer": "https://github.com/p4dr0one/arena-das-ias", "X-Title": "Arena das IAs" },
  },
  cloudflare: { env: null, json_mode: false },
};

// ------------------------------------------------------------------ utils --
const SP_FMT = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
function diaHora(iso) { return SP_FMT.format(new Date(iso)).replace(",", ""); }
function brl(v) { return "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function pct(v) { return (v > 0 ? "+" : "") + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%"; }
function r2(v) { return Math.round(v * 100) / 100; }
function r3(v) { return Math.round(v * 1000) / 1000; }
function isoSec(d) { return d.toISOString().replace(/\.\d{3}Z$/, "+00:00"); }
function log(msg) { console.log(msg); }

async function httpJson(url, { method = "GET", body = null, headers = {}, timeoutMs = 60000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: { "User-Agent": UA, "Accept": "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      signal: ctrl.signal,
    });
    const texto = await r.text();
    let dados = null;
    try { dados = JSON.parse(texto); } catch (_) { dados = null; }
    return { ok: r.ok, status: r.status, dados, texto, headers: r.headers };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------- mercado --
async function buscarMercado(env) {
  if (env.ARENA_MOCK === "1") return mercadoMock();
  const simbolos = ATIVOS.map((a) => `${a}-BRL`).join(",");
  const tk = await httpJson(`${MB}/tickers?symbols=${simbolos}`, { timeoutMs: 20000 });
  if (!tk.ok || !Array.isArray(tk.dados)) throw new Error(`tickers HTTP ${tk.status}`);
  const now = Math.floor(Date.now() / 1000);
  const m = {};
  for (const t of tk.dados) {
    const a = t.pair.split("-")[0];
    const last = +t.last, open = +t.open;
    m[a] = { last, buy: +t.buy, sell: +t.sell, high: +t.high, low: +t.low, vol: +t.vol, var_24h: open ? (last / open - 1) * 100 : 0 };
  }
  const velas = await Promise.all(ATIVOS.flatMap((a) => [
    httpJson(`${MB}/candles?symbol=${a}-BRL&resolution=1h&to=${now}&countback=24`, { timeoutMs: 20000 }),
    httpJson(`${MB}/candles?symbol=${a}-BRL&resolution=1d&to=${now}&countback=7`, { timeoutMs: 20000 }),
  ]));
  ATIVOS.forEach((a, i) => {
    const h = velas[i * 2].dados || {}, d = velas[i * 2 + 1].dados || {};
    m[a].h1 = (h.c || []).map((c) => Math.round(+c));
    m[a].d1 = (d.c || []).map((c) => Math.round(+c));
  });
  for (const a of ATIVOS) if (!m[a]) throw new Error(`sem ticker de ${a}`);
  return m;
}

function mercadoMock() {
  const base = { BTC: 421000, ETH: 12780, SOL: 561 };
  const seed = Math.floor(Date.now() / 1800000);
  const m = {};
  for (const a of ATIVOS) {
    const wobble = ((seed * 7 + a.length) % 13 - 6) / 1000;
    const last = base[a] * (1 + wobble);
    m[a] = {
      last, buy: last * 0.9995, sell: last * 1.0005, high: last * 1.01, low: last * 0.99, vol: 10, var_24h: wobble * 100,
      h1: Array.from({ length: 24 }, (_, i) => Math.round(last * (1 + ((i * 31 + seed) % 11 - 5) / 1000))),
      d1: Array.from({ length: 7 }, (_, i) => Math.round(last * (1 + ((i * 17 + seed) % 9 - 4) / 100))),
    };
  }
  return m;
}

function resumoMercado(m, quando) {
  const linhas = [`Mercado agora (Mercado Bitcoin, preços em reais), ${diaHora(quando)} horário de Brasília:`];
  for (const a of ATIVOS) {
    const x = m[a];
    const var1h = x.h1.length >= 2 ? (x.h1[x.h1.length - 1] / x.h1[x.h1.length - 2] - 1) * 100 : 0;
    const var7d = x.d1.length >= 2 ? (x.d1[x.d1.length - 1] / x.d1[0] - 1) * 100 : 0;
    const spread = x.buy ? (x.sell / x.buy - 1) * 100 : 0;
    linhas.push(`${a}: ${x.last.toFixed(0)} | 1h ${var1h.toFixed(2)}% | 24h ${x.var_24h.toFixed(2)}% | 7d ${var7d.toFixed(2)}% | máx 24h ${x.high.toFixed(0)} | mín 24h ${x.low.toFixed(0)} | spread ${spread.toFixed(2)}%`);
  }
  for (const a of ATIVOS) linhas.push(`Fechamentos de 1h do ${a} (24 velas, da mais antiga à atual): ${m[a].h1.join(", ")}`);
  for (const a of ATIVOS) linhas.push(`Fechamentos diários do ${a} (7 dias): ${m[a].d1.join(", ")}`);
  return linhas.join("\n");
}

// ------------------------------------------------------------------ estado --
function estadoNovo() {
  return {
    versao: 2, rodada: 0, atualizado_em: null,
    temporada: {
      numero: 0, nome: "Temporada 0", status: "aguardando", inicio: null, fim_previsto: null,
      capital_inicial: CAPITAL_INICIAL, taxa: TAXA, intervalo_min: INTERVALO_MIN, ativos: ATIVOS,
    },
    precos: {}, agentes: [], hodl: null, proxima_rodada_estimada: null,
  };
}

function agenteNovo(cfg) {
  const posicoes = {};
  for (const a of ATIVOS) posicoes[a] = 0;
  return {
    id: cfg.id, nome: cfg.nome, empresa: cfg.empresa, modelo: cfg.modelo, provedor: cfg.provedor, cor: cfg.cor,
    descricao: cfg.descricao, cadencia_min: cfg.cadencia_min,
    status: "sem_chave", entrou_na_rodada: null, entrou_em: null,
    caixa: CAPITAL_INICIAL, posicoes, patrimonio: CAPITAL_INICIAL, retorno_pct: 0, n_trades: 0, n_decisoes: 0,
    ultima_decisao: null, ultimo_erro: null,
  };
}

function patrimonio(ag, m) {
  let v = ag.caixa;
  for (const a of ATIVOS) v += (ag.posicoes[a] || 0) * m[a].buy;
  return v;
}

// ------------------------------------------------------------------ prompt --
function sistema(nome, cadencia) {
  return `Você é ${nome}, um agente de IA que opera numa arena pública chamada Arena das IAs.
Você compete contra outros modelos de IA. Todo mundo vê suas decisões e seu raciocínio.

Regras da arena:
- Dinheiro SIMULADO: cada agente começou com R$ 10.000. Vence quem tiver maior patrimônio no fim da temporada.
- Mercado à vista no Mercado Bitcoin: BTC, ETH e SOL contra reais. Sem alavancagem, sem venda a descoberto, sem derivativos.
- Toda operação paga 0,7% de taxa. Operar demais destrói patrimônio. Ficar parado é uma decisão válida.
- Você compra pelo preço de venda do livro (sell) e vende pelo preço de compra (buy).
- Uma decisão por rodada. A próxima rodada é em ${cadencia} minutos.

Responda SOMENTE com um objeto JSON, sem texto antes ou depois, neste formato:
{"acao": "comprar" | "vender" | "manter", "ativo": "BTC" | "ETH" | "SOL", "fracao": número entre 0 e 1, "raciocinio": "texto"}
- "fracao": em "comprar", a fração do seu CAIXA que você gasta; em "vender", a fração da sua POSIÇÃO naquele ativo que você vende; em "manter", 0.
- "raciocinio": no máximo 280 caracteres, em português do Brasil, falando direto com o público da arena. Sem jargão vazio. Diga o que você viu nos dados e por que decidiu isso.`;
}

function promptUsuario(ag, m, quando, ranking, prev) {
  const pos = ATIVOS.filter((a) => ag.posicoes[a] > 0).map((a) => `${a} ${ag.posicoes[a].toFixed(6)} (${brl(ag.posicoes[a] * m[a].buy)})`).join(" | ") || "nenhuma posição";
  const pat = patrimonio(ag, m);
  const ret = (pat / CAPITAL_INICIAL - 1) * 100;
  const rk = ranking.map(([n, r], i) => `${i + 1}º ${n} ${pct(r)}${n === ag.nome ? " (você)" : ""}`).join("; ") || "ainda sem ranking";
  const ult = prev.slice(-3).map((d) => `- ${diaHora(d.t)}: ${d.acao} ${d.ativo || ""} ${Math.round((d.fracao || 0) * 100)}% — "${d.raciocinio}"`).join("\n") || "- nenhuma ainda (esta é sua primeira rodada)";
  return `${resumoMercado(m, quando)}

Sua carteira: caixa ${brl(ag.caixa)} | ${pos} | patrimônio ${brl(pat)} (${pct(ret)} na temporada) | ${ag.n_trades} operações feitas
Suas últimas decisões:
${ult}
Ranking atual da arena: ${rk}

Decida agora. Responda só o JSON.`;
}

// --------------------------------------------------------------- chamadas --
class ErroProvedor extends Error {}

function temChave(cfg, env) {
  if (env.ARENA_MOCK === "1") return true;
  if (cfg.provedor === "cloudflare") return !!env.AI;
  return !!(env[PROVEDORES[cfg.provedor].env] || "").trim();
}

async function chamarModelo(cfg, env, sist, usuario) {
  if (env.ARENA_MOCK === "1") return { texto: mockResposta(cfg, usuario), meta: { mock: true } };
  const t0 = Date.now();
  if (cfg.provedor === "cloudflare") {
    try {
      const r = await env.AI.run(cfg.modelo, {
        messages: [{ role: "system", content: sist }, { role: "user", content: usuario }],
        max_tokens: 400, temperature: 0.7,
      });
      const texto = typeof r === "string" ? r : (r.response || "");
      return { texto, meta: { segundos: r2((Date.now() - t0) / 1000) } };
    } catch (e) {
      const msg = String(e && e.message || e);
      if (/429|quota|limit|neuron/i.test(msg)) throw new ErroProvedor("limite_atingido: " + msg.slice(0, 200));
      throw new ErroProvedor("workers_ai: " + msg.slice(0, 200));
    }
  }
  const prov = PROVEDORES[cfg.provedor];
  const chave = (env[prov.env] || "").trim();
  if (!chave) throw new ErroProvedor("sem_chave");
  const headers = { Authorization: `Bearer ${chave}`, ...(prov.headers || {}) };
  const corpo = {
    model: cfg.modelo,
    messages: [{ role: "system", content: sist }, { role: "user", content: usuario }],
    temperature: 0.7, max_tokens: 1200, ...(cfg.extra || {}),
  };
  const tentativas = prov.json_mode ? [{ ...corpo, response_format: { type: "json_object" } }, corpo] : [corpo];
  let ultimo = "erro desconhecido";
  for (let i = 0; i < tentativas.length; i++) {
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      let r;
      try {
        r = await httpJson(prov.url, { method: "POST", body: tentativas[i], headers, timeoutMs: 90000 });
      } catch (e) {
        ultimo = "rede: " + String(e && e.message || e).slice(0, 120);
        if (tentativa === 0) { await sleep(8000); continue; }
        throw new ErroProvedor(ultimo);
      }
      if (r.ok && r.dados) {
        const msg = ((r.dados.choices || [])[0] || {}).message || {};
        let texto = msg.content || "";
        if (!texto && typeof msg.reasoning === "string") texto = msg.reasoning;
        const uso = r.dados.usage || {};
        return { texto, meta: { segundos: r2((Date.now() - t0) / 1000), tokens: uso.total_tokens } };
      }
      ultimo = `HTTP ${r.status}: ${(r.texto || "").slice(0, 300)}`;
      if (r.status === 400 && i === 0 && tentativas.length > 1) break; // tenta sem json_mode
      if (r.status === 404 && cfg.provedor === "gemini" && i === 0) {
        const alt = await modeloGeminiAlternativo(chave, cfg.modelo);
        if (alt) { cfg.modelo = alt; tentativas.forEach((t) => { t.model = alt; }); log(`Gemini: trocando para ${alt}`); continue; }
      }
      if ([429, 500, 502, 503, 504].includes(r.status) && tentativa === 0) {
        const ra = parseInt(r.headers.get("Retry-After") || "", 10);
        const espera = Math.min(Number.isFinite(ra) && ra > 0 ? ra : 15, 40);
        log(`  ${cfg.nome}: ${ultimo.slice(0, 80)} — esperando ${espera}s`);
        await sleep(espera * 1000);
        continue;
      }
      if (r.status === 429) throw new ErroProvedor("limite_atingido: " + ultimo);
      if (r.status === 401 || r.status === 403) throw new ErroProvedor("chave_invalida: " + ultimo);
      throw new ErroProvedor(ultimo);
    }
  }
  throw new ErroProvedor(ultimo);
}

async function modeloGeminiAlternativo(chave, atual) {
  try {
    const r = await httpJson("https://generativelanguage.googleapis.com/v1beta/openai/models", { headers: { Authorization: `Bearer ${chave}` }, timeoutMs: 20000 });
    const ids = ((r.dados && r.dados.data) || []).map((x) => String(x.id || "").replace(/^models\//, ""));
    const lite = ids.filter((id) => /flash-lite/.test(id) && !/preview|exp|tts|image|live|audio/.test(id) && id !== atual).sort().reverse();
    const flash = ids.filter((id) => /flash/.test(id) && !/preview|exp|tts|image|live|audio|lite/.test(id) && id !== atual).sort().reverse();
    return lite[0] || flash[0] || null;
  } catch (_) {
    return null;
  }
}

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

function mockResposta(cfg, usuario) {
  let h = 0;
  const s = cfg.id + usuario.slice(0, 120);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const acao = ["comprar", "vender", "manter", "comprar"][h % 4];
  const ativo = ATIVOS[h % 3];
  const fracao = acao === "manter" ? 0 : [0.25, 0.5, 0.1, 1][(h >>> 8) % 4];
  return JSON.stringify({ acao, ativo, fracao, raciocinio: `[TESTE LOCAL, decisão falsa] ${cfg.nome} escolheu ${acao} ${ativo}.` });
}

// Acha o primeiro objeto JSON com "acao" dentro de uma resposta livre.
function extrairJson(texto) {
  texto = String(texto || "").replace(/<think>[\s\S]*?<\/think>/gi, " ").replace(/```(?:json)?/gi, " ");
  for (let i = texto.indexOf("{"); i !== -1; i = texto.indexOf("{", i + 1)) {
    let prof = 0, emStr = false, esc = false;
    for (let j = i; j < texto.length; j++) {
      const c = texto[j];
      if (emStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') emStr = false; continue; }
      if (c === '"') emStr = true;
      else if (c === "{") prof++;
      else if (c === "}") { prof--; if (prof === 0) { try { const o = JSON.parse(texto.slice(i, j + 1)); if (o && typeof o === "object" && "acao" in o) return o; } catch (_) { /* segue */ } break; } }
    }
  }
  return null;
}

function normalizarDecisao(obj) {
  if (!obj || typeof obj !== "object") return null;
  const acao = String(obj.acao || "").trim().toLowerCase();
  if (!["comprar", "vender", "manter"].includes(acao)) return null;
  const ativo = String(obj.ativo || "").trim().toUpperCase();
  if (acao !== "manter" && !ATIVOS.includes(ativo)) return null;
  let fracao = parseFloat(obj.fracao);
  if (!Number.isFinite(fracao)) fracao = 0;
  fracao = Math.max(0, Math.min(1, fracao));
  let rac = String(obj.raciocinio || "").trim().replace(/\s*\n\s*/g, " ");
  if (rac.length > 400) rac = rac.slice(0, 397) + "...";
  return { acao, ativo: acao !== "manter" ? ativo : null, fracao: acao !== "manter" ? fracao : 0, raciocinio: rac || "(sem explicação)" };
}

// ---------------------------------------------------------------- carteira --
function aplicar(ag, dec, m) {
  const { acao, ativo, fracao } = dec;
  if (acao === "comprar") {
    const gasto = ag.caixa * fracao, preco = m[ativo].sell;
    if (gasto < TRADE_MINIMO) return { executada: false, motivo: "valor abaixo do mínimo de R$ 50", valor: 0, preco };
    const qtd = gasto * (1 - TAXA) / preco;
    ag.caixa -= gasto; ag.posicoes[ativo] += qtd; ag.n_trades += 1;
    return { executada: true, valor: gasto, preco, quantidade: qtd, taxa: gasto * TAXA };
  }
  if (acao === "vender") {
    const qtd = ag.posicoes[ativo] * fracao, preco = m[ativo].buy, bruto = qtd * preco;
    if (bruto < TRADE_MINIMO) {
      return { executada: false, motivo: ag.posicoes[ativo] <= 0 ? "não tinha posição suficiente" : "valor abaixo do mínimo de R$ 50", valor: 0, preco };
    }
    ag.posicoes[ativo] -= qtd;
    if (ag.posicoes[ativo] < 1e-9) ag.posicoes[ativo] = 0;
    ag.caixa += bruto * (1 - TAXA); ag.n_trades += 1;
    return { executada: true, valor: bruto, preco, quantidade: qtd, taxa: bruto * TAXA };
  }
  return { executada: true, valor: 0, preco: null };
}

// ------------------------------------------------------------------ rodada --
async function rodada(env) {
  const quando = new Date(Math.floor(Date.now() / 1000) * 1000);
  const quandoIso = isoSec(quando);
  const [estado, historico, decisoes] = await Promise.all([
    env.ARENA.get("state", "json").then((v) => v || estadoNovo()),
    env.ARENA.get("historico", "json").then((v) => v || []),
    env.ARENA.get("decisoes", "json").then((v) => v || []),
  ]);
  const temporada = estado.temporada;

  log(`Rodada ${estado.rodada + 1} — buscando mercado${env.ARENA_MOCK === "1" ? " (MOCK)" : ""}`);
  const m = await buscarMercado(env);
  estado.rodada += 1;
  const n = estado.rodada;

  const porId = Object.fromEntries((estado.agentes || []).map((a) => [a.id, a]));
  const lista = agentes(env).map((cfg) => {
    const ag = porId[cfg.id] || agenteNovo(cfg);
    for (const k of ["nome", "empresa", "modelo", "cor", "descricao", "cadencia_min", "provedor"]) ag[k] = cfg[k];
    ag.posicoes = ag.posicoes || {};
    for (const a of ATIVOS) if (!(a in ag.posicoes)) ag.posicoes[a] = 0;
    return { cfg, ag };
  });
  estado.agentes = lista.map((x) => x.ag);

  const rankingPrev = lista
    .filter(({ ag }) => ["ativo", "erro", "limite"].includes(ag.status))
    .map(({ ag }) => [ag.nome, (patrimonio(ag, m) / CAPITAL_INICIAL - 1) * 100])
    .sort((a, b) => b[1] - a[1]);

  let alguemAtivo = false;
  const tarefas = [];
  for (const { cfg, ag } of lista) {
    if (!temChave(cfg, env)) {
      ag.status = "sem_chave";
      ag.patrimonio = r2(patrimonio(ag, m));
      ag.retorno_pct = r3((ag.patrimonio / CAPITAL_INICIAL - 1) * 100);
      continue;
    }
    if (ag.entrou_na_rodada == null) { ag.entrou_na_rodada = n; ag.entrou_em = quandoIso; }
    const passo = Math.max(1, Math.floor(cfg.cadencia_min / INTERVALO_MIN));
    if ((n - ag.entrou_na_rodada) % passo !== 0) {
      alguemAtivo = true;
      ag.patrimonio = r2(patrimonio(ag, m));
      ag.retorno_pct = r3((ag.patrimonio / CAPITAL_INICIAL - 1) * 100);
      log(`${ag.nome}: fora da cadência nesta rodada`);
      continue;
    }
    const prev = decisoes.filter((d) => d.agente === ag.id);
    const sist = sistema(ag.nome, cfg.cadencia_min);
    const usuario = promptUsuario(ag, m, quandoIso, rankingPrev, prev);
    tarefas.push(
      chamarModelo(cfg, env, sist, usuario)
        .then((r) => ({ cfg, ag, ok: true, ...r }))
        .catch((e) => ({ cfg, ag, ok: false, erro: e instanceof ErroProvedor ? e.message : "falha: " + String(e && e.message || e).slice(0, 160) })),
    );
  }

  const resultados = await Promise.all(tarefas);
  for (const res of resultados) {
    const { cfg, ag } = res;
    const registro = { t: quandoIso, n, agente: ag.id, nome: ag.nome };
    if (res.ok) {
      let dec = normalizarDecisao(extrairJson(res.texto));
      if (!dec) {
        dec = { acao: "manter", ativo: null, fracao: 0, raciocinio: "Resposta fora do formato. A arena registrou como manter." };
        registro.resposta_invalida = String(res.texto || "").slice(0, 200);
      }
      const exe = aplicar(ag, dec, m);
      ag.status = "ativo"; ag.ultimo_erro = null; alguemAtivo = true;
      Object.assign(registro, dec, { executada: exe.executada, valor: r2(exe.valor || 0), preco: exe.preco ?? null, motivo: exe.motivo ?? null, meta: res.meta });
      log(`${ag.nome}: ${dec.acao} ${dec.ativo || ""} ${Math.round(dec.fracao * 100)}% — ${dec.raciocinio.slice(0, 90)}`);
    } else {
      const msg = res.erro;
      ag.status = msg.startsWith("limite_atingido") ? "limite" : (msg === "sem_chave" ? "sem_chave" : "erro");
      ag.ultimo_erro = msg.slice(0, 200);
      alguemAtivo = alguemAtivo || ag.status !== "sem_chave";
      Object.assign(registro, { acao: "manter", ativo: null, fracao: 0, raciocinio: "Sem resposta do provedor nesta rodada. A arena registrou como manter.", executada: false, valor: 0, preco: null, erro: msg.slice(0, 200) });
      log(`${ag.nome}: ERRO ${msg.slice(0, 120)}`);
    }
    ag.n_decisoes += 1;
    ag.patrimonio = r2(patrimonio(ag, m));
    ag.retorno_pct = r3((ag.patrimonio / CAPITAL_INICIAL - 1) * 100);
    registro.patrimonio_apos = ag.patrimonio;
    const campos = ["t", "n", "acao", "ativo", "fracao", "raciocinio", "executada", "valor", "preco", "motivo"];
    ag.ultima_decisao = Object.fromEntries(campos.map((k) => [k, registro[k] ?? null]));
    decisoes.push(registro);
  }

  if (alguemAtivo && temporada.status === "aguardando") {
    temporada.status = "em_andamento";
    temporada.inicio = quandoIso;
    temporada.fim_previsto = isoSec(new Date(quando.getTime() + DURACAO_TEMPORADA_DIAS * 86400000));
    estado.hodl = { btc: CAPITAL_INICIAL * (1 - TAXA) / m.BTC.sell, preco_entrada: m.BTC.sell };
    log("Temporada 0 começou.");
  }
  if (temporada.status === "em_andamento" && temporada.fim_previsto && quando >= new Date(temporada.fim_previsto)) {
    temporada.status = "encerrada";
    temporada.fim = quandoIso;
    log("Temporada encerrada.");
  }

  let hodl = null;
  if (estado.hodl) {
    const v = estado.hodl.btc * m.BTC.buy;
    hodl = { patrimonio: r2(v), retorno_pct: r3((v / CAPITAL_INICIAL - 1) * 100), preco_entrada: estado.hodl.preco_entrada };
    Object.assign(estado.hodl, hodl);
  }

  estado.precos = Object.fromEntries(ATIVOS.map((a) => [a, Object.fromEntries(Object.entries(m[a]).filter(([k]) => k !== "h1" && k !== "d1").map(([k, v]) => [k, typeof v === "number" ? r2(v) : v]))]));
  estado.atualizado_em = quandoIso;
  estado.proxima_rodada_estimada = isoSec(new Date(quando.getTime() + INTERVALO_MIN * 60000));
  estado.agentes.sort((a, b) => (a.status === "sem_chave") - (b.status === "sem_chave") || b.patrimonio - a.patrimonio);

  historico.push({
    t: quandoIso, n,
    p: Object.fromEntries(ATIVOS.map((a) => [a, r2(m[a].last)])),
    e: Object.fromEntries(lista.filter(({ ag }) => ag.status !== "sem_chave").map(({ ag }) => [ag.id, ag.patrimonio])),
    hodl: hodl ? hodl.patrimonio : null,
  });
  const hist = historico.slice(-MAX_HISTORICO);
  const decs = decisoes.slice(-MAX_DECISOES);

  await Promise.all([
    env.ARENA.put("state", JSON.stringify(estado)),
    env.ARENA.put("historico", JSON.stringify(hist)),
    env.ARENA.put("decisoes", JSON.stringify(decs)),
    env.ARENA.put("boletim", boletim(estado)),
  ]);
  for (const { ag } of lista) log(`  ${ag.nome.padEnd(18)} ${ag.status.padEnd(9)} ${brl(ag.patrimonio)} (${pct(ag.retorno_pct)})`);
  return estado;
}

function boletim(estado) {
  const ag = (estado.agentes || []).filter((a) => a.status !== "sem_chave").slice().sort((a, b) => b.patrimonio - a.patrimonio);
  const linhas = [`Arena das IAs, placar de ${estado.atualizado_em ? diaHora(estado.atualizado_em) : "--"}:`];
  ag.forEach((a, i) => linhas.push(`${i + 1}º ${a.nome} ${pct(a.retorno_pct)}`));
  if (estado.hodl && estado.hodl.retorno_pct != null) linhas.push(`Quem só comprou BTC e ficou quieto: ${pct(estado.hodl.retorno_pct)}`);
  const falou = ag.find((a) => a.ultima_decisao && a.ultima_decisao.raciocinio && !/^Sem resposta|^Resposta fora/.test(a.ultima_decisao.raciocinio));
  if (falou) linhas.push("", `${falou.nome} disse: "${falou.ultima_decisao.raciocinio}"`);
  const t = estado.temporada || {};
  if (t.status === "em_andamento" && t.inicio) {
    const dias = Math.max(1, Math.floor((Date.now() - new Date(t.inicio).getTime()) / 86400000) + 1);
    linhas.push("", `Dia ${dias} de 14. Dinheiro simulado, decisões reais das IAs, a cada 30 min.`);
  }
  return linhas.join("\n") + "\n";
}

// ---------------------------------------------------------------- handlers --
const ARQUIVOS = { "/data/state.json": "state", "/data/historico.json": "historico", "/data/decisoes.json": "decisoes" };

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(rodada(env).catch((e) => console.error("rodada falhou:", e && e.stack || e)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const chave = ARQUIVOS[url.pathname];
    if (chave) {
      const v = await env.ARENA.get(chave);
      const corpo = v != null ? v : (chave === "state" ? JSON.stringify(estadoNovo()) : "[]");
      return new Response(corpo, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" } });
    }
    if (url.pathname === "/boletim.txt") {
      const v = await env.ARENA.get("boletim");
      return new Response(v || "A arena ainda não rodou a primeira rodada.\n", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=60" } });
    }
    if (url.pathname === "/api/rodar" && env.ARENA_MOCK === "1") {
      // Só existe em desenvolvimento local, para testar uma rodada sem esperar o cron.
      const estado = await rodada(env);
      return Response.json({ ok: true, rodada: estado.rodada });
    }
    return env.ASSETS.fetch(request);
  },
};
