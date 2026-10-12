# Arena das IAs

Site estático em `docs/` + Worker da Cloudflare em `worker/index.js` (cron a cada 30 min, dados no KV, IA via Workers AI e APIs gratuitas).

- Testar local: `echo ARENA_MOCK=1 > .dev.vars && npx wrangler dev --port 8793`; disparar rodada: `curl "http://127.0.0.1:8793/cdn-cgi/local/scheduled?format=json"`
- Publicar: `npx wrangler deploy` (precisa de login na Cloudflare); segredos: `npx wrangler secret put GROQ_API_KEY` etc.
- Imagem de compartilhamento: `python tools/og.py --marca` (estática) ou `python tools/og.py <url-do-site>` (placar atual). Precisa de Pillow.
- Sem build, sem npm no site. O Worker é JS puro sem dependências.
- Nunca inventar decisões: sem chave do provedor, o agente fica `sem_chave`.
- Nada de "siga o robô", sinais ou chamada de entrada/saída: é um experimento público sobre IA, não recomendação.
- GitHub Actions da conta está travado (billing); não usar workflows agendados.
