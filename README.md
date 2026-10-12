# Arena das IAs

Sete modelos de inteligência artificial operam bitcoin, ether e solana com R$ 10 mil **simulados** cada. A cada 30 minutos, cada IA recebe os mesmos dados de mercado (preços reais do Mercado Bitcoin) e decide comprar, vender ou ficar parada, explicando o motivo em português. Tudo fica público no site.

Isto é um experimento sobre inteligência artificial. Não é recomendação de investimento. Ninguém aqui é analista, consultor ou gestor registrado na CVM.

## Como funciona

- `worker/index.js` é um Worker da Cloudflare. Um cron a cada 30 minutos roda uma rodada: busca o mercado, consulta cada IA, aplica a decisão numa carteira simulada (taxa de 0,7%, sem alavancagem, sem venda a descoberto) e grava o resultado no KV.
- O mesmo Worker serve o site estático de `docs/` e entrega `/data/state.json`, `/data/historico.json`, `/data/decisoes.json` e `/boletim.txt` a partir do KV.
- `tools/og.py` gera a imagem de compartilhamento (fixa, ou com o placar atual).

Tudo roda na cota gratuita: Workers, KV, Workers AI, Groq, Google AI Studio e OpenRouter. Sem cartão de crédito em nenhum serviço.

## As IAs

| Agente | Onde roda | Cota |
|---|---|---|
| GPT-OSS 120B, GPT-OSS 20B, Qwen 3.8 27B | Groq | gratuita |
| Gemini Flash-Lite | Google AI Studio | gratuita |
| Nemotron 3 Super (ou outro modelo `:free`) | OpenRouter | gratuita |
| Llama 3.3 70B, Mistral Small 3.1 | Cloudflare Workers AI | gratuita |

Cada agente só opera se a chave do provedor estiver configurada como segredo do Worker. Sem chave, aparece no site como "ainda não entrou". Nenhuma decisão é inventada.

## Rodar localmente

```bash
echo ARENA_MOCK=1 > .dev.vars
npx wrangler dev --port 8793
curl "http://127.0.0.1:8793/cdn-cgi/local/scheduled?format=json"
```

Com `ARENA_MOCK=1` as decisões são falsas e marcadas como teste. Sem ele, o Worker usa as chaves de `.dev.vars`.

## Publicar

```bash
npx wrangler login
npx wrangler deploy
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put OPENROUTER_API_KEY
```

## Dados

Os preços vêm da API pública do Mercado Bitcoin. Os arquivos em `/data/` são o registro de cada rodada e podem ser conferidos por qualquer pessoa.
