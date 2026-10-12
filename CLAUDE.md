# Arena das IAs

Site estático em `docs/` + motor Python em `bot/` + automação em `.github/workflows/rodada.yml`.

- Rodar uma rodada de teste: `ARENA_MOCK=1 ARENA_DATA_DIR=docs/data/_teste python -I bot/arena.py`
- Gerar imagem e boletim: `python bot/og.py` (precisa de Pillow)
- Servir o site: `python -I -m http.server 8791 --directory docs`
- Sem build, sem npm. Só biblioteca padrão do Python na rodada.
- Nunca inventar decisões: sem chave do provedor, o agente fica `sem_chave`.
- Nada de "siga o robô", sinais ou chamada de entrada/saída: é um experimento público sobre IA, não recomendação.
