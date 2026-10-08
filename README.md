# Agent Athina 🤖📱

Agente de atendimento automático via WhatsApp para financiamento de celulares **Nuovopay**, com IA (modelos open-source ou NVIDIA NIM), TTS local em português e painel de operação em tempo real.

## Arquitetura

```
┌─────────────┐   Socket.IO   ┌──────────────────────────────┐
│  Painel Web │◄─────────────►│  Backend Node.js/TS (3001)   │
│ React (5173)│               │  ├─ AgentService (autônomo)  │
└─────────────┘               │  │    └─ tool: Paymobi/PIX   │
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
#      AGENT_MODEL=qwen3:8b
#      AGENT_AUTOREPLY=true

# 5. Ligar tudo (frontend + backend + TTS)
npm run dev
```

- Painel: http://127.0.0.1:5173
- Backend/health: http://localhost:3001/health
- TTS: http://127.0.0.1:5050

Escaneie o QR Code exibido no painel com o WhatsApp do número de atendimento. Pronto.

## Modos de operação

| Modo | Config | Comportamento |
|------|--------|---------------|
| **Painel (padrão)** | `AGENT_AUTOREPLY=false` | O painel conduz as respostas; o agente só sugere texto |
| **Autônomo** | `AGENT_AUTOREPLY=true` | O servidor responde clientes sozinho (24/7, painel fechado ok); o painel entra em modo monitor |

No modo autônomo o agente usa **tool-calling**: consulta o contrato no Paymobi (CPF ou IMEI) e responde com parcela, vencimento, valor e **código PIX copia-e-cola**.

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
| ⚡ Chatterbox Masc (BR) | **NVIDIA Chatterbox** (premium) | masculina | painel → `riva_male` |
| ✨ Louise (BR) | **NVIDIA Magpie** (premium) | feminina | painel → `magpie_louise` |
| ✨ Isabela (BR) | **NVIDIA Magpie** (premium) | feminina | painel → `magpie_isabela` |

Se o Chatterbox/Magpie falhar (sem chave, nuvem fora), o servidor cai **automaticamente** para o Kokoro local — o cliente sempre recebe áudio. Amostras: `backend/debug/*.ogg`.

Notas: o Chatterbox hosted expõe apenas voz masculina em pt-BR (clonagem zero-shot é rejeitada pelo servidor); as vozes femininas premium são da Magpie. Cota da NVIDIA NIM: limite de taxa por modelo não publicado (varia com o tráfego geral), visível só na web UI do build.nvidia.com — exceder retorna 429.

O botão **Ouvir** do painel gera o áudio e tenta tocar automaticamente; se o navegador bloquear o autoplay, o botão **▶ Tocar** aparece e reproduz no clique.

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
| `npm --prefix backend run test:tts` | Teste de integração Node → TTS local |
| `npm run build` / `npm run typecheck` / `npm run lint` | Build, tipos, lint do frontend |
| `npm --prefix backend run typecheck` | Tipos do backend |
| `npm --prefix backend run clean` | Limpa sessão WhatsApp + browsers zumbis |

## Documentação

- [`shared/contracts.ts`](shared/contracts.ts) — contratos Socket.IO compartilhados painel↔backend (fonte única de eventos e payloads; alias `@shared` nos dois lados)
- [`MODELOS_IA.md`](MODELOS_IA.md) — escolha de TTS (Kokoro) e LLMs open-source (Qwen3), como configurar, checklist de operação
- [`STACK_AVALIACAO.md`](STACK_AVALIACAO.md) — frameworks (Electron/Tauri/Rust), atualizações e roadmap de autonomia
- [`PLANO_MELHORIAS_PRODUCAO.md`](PLANO_MELHORIAS_PRODUCAO.md) — correções de segurança/confiabilidade para produção
- [`AUDIT_REPORT.md`](AUDIT_REPORT.md) — auditoria inicial

## Requisitos

- Node.js 24+ (LTS)
- Python 3.10+ (apenas para o TTS)
- Redis (opcional — chat state/analytics/filas caem para memória sem ele)
- Ollama (opcional — modelos locais) ou chave NVIDIA NIM
- Chrome/Chromium (via Puppeteer, para WhatsApp Web)
