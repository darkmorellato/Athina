# Agent Athina 🤖📱

Agente de atendimento automático via WhatsApp para financiamento de celulares **Nuovopay**, com IA (modelos open-source ou NVIDIA NIM), TTS local em português e painel de operação em tempo real.

## Arquitetura

```
┌─────────────┐   Socket.IO   ┌──────────────────────────────┐
│  Painel Web │◄─────────────►│  Backend Node.js/TS (3001)   │
│ React (5173)│               │  ├─ AthinaFlowService (24/7) │
└─────────────┘               │  │    └─ roteiro: Paymobi/PIX│
                              │  ├─ WhatsAppService (QR)     │
                              │  └─ TTSService ──► Kokoro    │
                              │        (TTS 5050, pt-BR)     │
                              └──────────────┬───────────────┘
                                             │
                                    Ollama / NVIDIA NIM (LLM)
```

## 🚀 Ligar a aplicação (passo a passo)

```bash
# 1. Dependências (uma vez)
npm install && npm --prefix backend install

# 2. Servidor de voz local (uma vez)
npm run setup:tts

# 3. Credenciais
cp backend/.env.example backend/.env
#    Preencha: NVIDIA_API_KEY (ou AI_BASE_URL do Ollama),
#              PAYMOBI_EMAIL, PAYMOBI_PASSWORD, ADMIN_SECRET

# 4. (Opcional, recomendado) Modelo open-source local para o agente
ollama pull qwen3:8b
#    No backend/.env:
#      AI_BASE_URL=http://127.0.0.1:11434/v1
#      AI_API_KEY=ollama
#      AI_MODEL=qwen3:8b
#      AGENT_AUTOREPLY=true

# 5. Ligar tudo (frontend + backend + TTS)
npm run dev
```

- Painel: http://127.0.0.1:5173
- Backend/health: http://localhost:3001/health
- TTS: http://127.0.0.1:5050

Escaneie o QR Code exibido no painel com o WhatsApp do número de atendimento. Pronto.

## Atendimento automático

O único atendimento automático é o roteiro do `workflow athina.excalidraw`, implementado em `backend/src/services/AthinaFlowService.ts` (liga com `AGENT_AUTOREPLY=true`; roda 24/7 no servidor, com o painel fechado — o painel apenas monitora e permite resposta manual do operador, que pausa o robô para aquele contato).

Fluxo: coleta nome + CPF/IMEI → consulta o contrato no Paymobi → menu (1 pagar boleto/PIX, 2 verificar saldo, 3 celular bloqueado por comprovante, 4 falar com atendente). Transferências notificam os contatos de `HUMAN_HANDOFF_CONTACTS`. O único ponto com IA é a leitura opcional do comprovante: o OCR hospedado da NVIDIA (`AGENT_VISION_MODEL`, padrão `nvidia/nemotron-ocr-v2`) lê o texto e uma regra fixa decide PIX vs. boleto. Não há LLM decidindo respostas.

## 🔒 Segurança do painel

- O handshake do Socket.IO é autenticado: com `ADMIN_SECRET` definido no `backend/.env`, o painel precisa do token para conectar — defina uma vez no console do navegador: `localStorage.setItem('athina_admin_token', '<ADMIN_SECRET>')`. Sem `ADMIN_SECRET`, apenas conexões da própria máquina (loopback) são aceitas.
- `/live` responde sempre 200 enquanto o processo vive (use em supervisores — reconexão do WhatsApp **não** deve reiniciar o serviço); `/health` continua com o detalhe de prontidão.
- `TRUST_PROXY=<n>` habilita rate limit por IP atrás de reverse proxy (0 = exposto direto). Em produção, defina também `NODE_ENV` e `ALLOWED_ORIGIN`.

## 🎓 Treinamento de respostas

- Base de conhecimento única: **SQLite local** (`backend/data/athina.db`, via `node:sqlite` nativo) — regras operacionais + exemplos reais de perguntas e respostas. O antigo `backend/learning_database.json` é **importado automaticamente na primeira execução** e fica no repo como arquivo-fonte histórico
- **Aprendizado automático**: quando o operador responde um cliente manualmente no painel, o par *pergunta do cliente → resposta aprovada* entra na base automaticamente (com dedupe e atualização de pares repetidos)
- O agente autônomo carrega o treinamento **dinamicamente em cada resposta** (regras + exemplos mais recentes, teto de ~8K caracteres), logo edições passam a valer na hora
- O painel (aba Treinamento) sincroniza: ao conectar recebe a base persistida, e edições do painel são **salvas no servidor** e propagadas para todos os clientes
- Eventos: `update-training-rules`, `update-training-qas`, `request-training` → resposta `training-data` / `training-data-updated`

Para adicionar conhecimento: use o painel (aba Treinamento) com novas regras e pares pergunta/resposta — ou simplesmente responda clientes pelo painel e deixe o aprendizado automático trabalhar.

## 🔊 Vozes (TTS)

| Voz | Origem | Sexo | Como usar |
|-----|--------|------|-----------|
| 🌸 Dora (BR) | **Kokoro local** (grátis, ONNX) | feminina | padrão do painel |
| 🎙️ Alex (BR) | **Kokoro local** (grátis, ONNX) | masculina | painel → `pm_alex` |
| ⚡ Chatterbox Masc (BR) | **NVIDIA Chatterbox** (premium) | masculina | painel → `riva_male` |
| ✨ Louise (BR) | **NVIDIA Magpie** (premium) | feminina | painel → `magpie_louise` |
| ✨ Isabela (BR) | **NVIDIA Magpie** (premium) | feminina | painel → `magpie_isabela` |

Se o Chatterbox/Magpie falhar (sem chave, nuvem fora), o servidor cai **automaticamente** para o Kokoro local — o cliente sempre recebe áudio. Amostras: `backend/debug/*.ogg`.

**Normalização pt-BR para fala**: antes da síntese, `backend/tts_normalize.py` expande o texto para fala natural — `R$ 1.234,56` → "mil duzentos e trinta e quatro reais e cinquenta e seis centavos", CPF/CNPJ/IMEI dígito a dígito, datas com mês, emojis/markdown/códigos PIX removidos (testes: `backend/.venv/bin/python backend/tests/test_tts_normalize.py`). A resposta do `/tts` inclui `provider` e `voiceUsed`; `"normalize": false` desliga a normalização (depuração).

Notas: o Chatterbox hosted expõe apenas voz masculina em pt-BR (clonagem zero-shot é rejeitada pelo servidor); as vozes femininas premium são da Magpie. Cota da NVIDIA NIM: limite de taxa por modelo não publicado (varia com o tráfego geral), visível só na web UI do build.nvidia.com — exceder retorna 429.

O botão **Ouvir** do painel gera o áudio e tenta tocar automaticamente; se o navegador bloquear o autoplay, o botão **▶ Tocar** aparece e reproduz no clique.

## 📊 Observabilidade (opcional)

É **opt-in** — sem as variáveis no `backend/.env` ficam 100% desligados (zero overhead):

| Recurso | Como ativar | O que faz |
| --- | --- | --- |
| Tracing das decisões do LLM (Langfuse) | `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` | Exporta cada chamada de LLM (prompt/resposta/tokens) via OpenTelemetry — Langfuse Cloud ou self-host (`LANGFUSE_BASEURL`) |

Smoke: `npx --prefix backend tsx tests/_tracing_smoke.ts` (não precisa de conta).

## Scripts

| Comando | Descrição |
|---------|-----------|
| `npm run dev` | Frontend + Backend + TTS (reutiliza o TTS se já ativo) |
| `npm run dev:backend` | Só backend (tsx watch) |
| `npm run dev:tts` | Só servidor TTS (usa venv, port 5050) |
| `npm run setup:tts` | Cria venv (Python 3.13 via uv) e instala Kokoro 0.6.x |
| `npm --prefix backend test` | Testes de fumaça do agente autônomo + aprendizado |
| `npx --prefix backend tsx tests/_agent_precision.ts` | Precisão do agente com LLM real (NIM) — sem WhatsApp |
| `npx --prefix backend tsx tests/_ai_smoke.ts` | Teste do AIService do painel com a chave do .env |
| `npx --prefix backend tsx tests/_sqlite_services_smoke.ts` | SQLite: treinamento/analytics (round-trip + persistência) |
| `npx --prefix backend tsx tests/_pix_processor_smoke.ts` | Processamento de PIX do scraper (Playwright, fixture local) |
| `npm run test` / `npm run test:e2e` | Testes de componente (Vitest) / E2E do painel (Playwright) |
| `npm --prefix backend run test:tts` | Teste de integração Node → TTS local |
| `npm run build` / `npm run typecheck` / `npm run lint` | Build, tipos, lint do frontend |
| `npm --prefix backend run typecheck` | Tipos do backend |
| `npm --prefix backend run clean` | Limpa sessão WhatsApp + browsers zumbis |

## Documentação

- [`shared/contracts.ts`](shared/contracts.ts) — contratos Socket.IO compartilhados painel↔backend (fonte única de eventos e payloads; alias `@shared` nos dois lados)
- [`deploy/athina-backend.service`](deploy/athina-backend.service) — serviço systemd para rodar 24/7

## Requisitos

- Node.js 24+ (LTS — ver `.nvmrc`)
- Python 3.10+ (apenas para o TTS)
- Ollama (opcional — modelos locais) ou chave NVIDIA NIM
- Chrome/Chromium (via Puppeteer, para WhatsApp Web)

## 🏭 Produção

- **Serviço 24/7:** instale `deploy/athina-backend.service` com systemd (`Restart=always`). A sessão do WhatsApp fica em `backend/.wwebjs_auth` — não apague entre reinícios, senão será preciso escanear o QR de novo.
- **Persistência:** tudo fica em `backend/data/athina.db` (SQLite). Não há Redis.
- **Retenção de dados (política de 90 dias):** o sistema guarda apenas o estado do atendimento em andamento (expira em 24h), totais agregados sem dados pessoais e a base de treinamento. Não guardamos comprovantes nem o histórico de conversas — o histórico fica no WhatsApp do operador. Números, CPF e IMEI não são gravados na base de aprendizado.
- **Integração contínua:** `.github/workflows/ci.yml` roda typecheck, lint e testes (frontend e backend) a cada push.
- **Atendentes humanos:** `HUMAN_HANDOFF_CONTACTS` lista os contatos que recebem as transferências. Se a notificação falhar, o erro aparece no log como `[HumanHandoff]`.

## 🧪 Como testar

```bash
npm run typecheck && npm --prefix backend run typecheck   # tipos (frontend e backend)
npm run lint                                              # lint (deve sair sem avisos)
npm run test                                              # testes do painel (Vitest)
npm --prefix backend test                                 # roteiro da Athina (banco em memória)
```

Os testes do roteiro (`backend/tests/athina_flow.smoke.ts`) não tocam o WhatsApp nem o Paymobi: usam dependências simuladas. Para testar de ponta a ponta, use um número de teste e siga os ramos do menu (`AGENT_AUTOREPLY=true`).

## 🖥️ Atalho de desktop

`scripts/athina-panel.sh` sobe o frontend e o TTS se estiverem parados, verifica o backend e abre o painel numa janela própria. O atalho fica em `deploy/athina-panel.desktop`; copie para `~/.local/share/applications/` e `~/Desktop/` para usá-lo pelo menu ou pela área de trabalho.
