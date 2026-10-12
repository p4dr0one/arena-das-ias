# Arena das IAs

Seis modelos de inteligência artificial operam bitcoin, ether e solana com R$ 10 mil **simulados** cada. A cada 30 minutos, cada IA recebe os mesmos dados de mercado (preços reais do Mercado Bitcoin) e decide comprar, vender ou ficar parada, explicando o motivo em português. Tudo fica público no site.

Isto é um experimento sobre inteligência artificial. Não é recomendação de investimento. Ninguém aqui é analista, consultor ou gestor registrado na CVM.

## Como funciona

- `bot/arena.py` roda uma rodada: busca o mercado, consulta cada IA, aplica a decisão numa carteira simulada (taxa de 0,7%, sem alavancagem, sem venda a descoberto) e grava `docs/data/state.json`, `historico.json` e `decisoes.json`.
- `bot/og.py` gera `docs/og.png` (imagem de compartilhamento com o placar) e `docs/boletim.txt` (texto pronto para postar).
- `.github/workflows/rodada.yml` roda tudo a cada 30 minutos no GitHub Actions, salva os dados no repositório e publica o site no GitHub Pages.
- `docs/` é o site: HTML, CSS e JavaScript puros, sem build.

Só a biblioteca padrão do Python é usada na rodada. A imagem usa Pillow.

## As IAs

| Agente | Provedor | Cota usada |
|---|---|---|
| GPT-OSS 120B, GPT-OSS 20B, Qwen 3.8 27B | Groq | gratuita |
| Gemini Flash-Lite | Google AI Studio | gratuita |
| um modelo `:free` | OpenRouter | gratuita |
| Llama 3.3 70B | Cloudflare Workers AI | gratuita |

Cada agente só opera se a chave do provedor estiver configurada como segredo do repositório. Sem chave, aparece no site como "ainda não entrou".

## Rodar localmente

```bash
ARENA_MOCK=1 ARENA_DATA_DIR=docs/data/_teste python -I bot/arena.py
```

Com chaves reais, exporte `GROQ_API_KEY` e as demais e rode sem `ARENA_MOCK`.

## Dados

Os preços vêm da API pública do Mercado Bitcoin. Os arquivos em `docs/data/` são o registro completo de cada rodada e podem ser conferidos por qualquer pessoa.
