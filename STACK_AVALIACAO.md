# 🧭 Avaliação de Stack — Frameworks, Linguagens e Autonomia do Agente
**Data:** 07/10/2026  
**Escopo:** Agent-Athina (Frontend React + Backend Node.js/TS + TTS Python)  
**Método:** versões verificadas em tempo real via npm registry e crates.io

---

## 1. Diagnóstico: o que falta para ser um agente REALMENTE autônomo

### Fluxo atual
```
WhatsApp → backend (Socket.IO) → FRONTEND decide (stageCollecting.ts,
stageConfirmation.ts, paymobiHandlers.ts) → ai-request → NVIDIA NIM → resposta
```

### Lacunas críticas
| # | Lacuna | Impacto |
|---|--------|---------|
| 1 | **Orquestração roda no navegador** (hooks do frontend) | Agente morre se o painel fechar; não é autônomo |
| 2 | **Sem tool-calling/planejamento** (apenas resposta 1-shot) | Não decide sozinho executar ações (consultar, confirmar, reagendar) |
| 3 | **Sem memória de longo prazo** (só estado de 24h no Redis) | Não aprende com interações passadas |
| 4 | **Sem observabilidade das decisões** | Impossível auditar custo/qualidade do agente |
| 5 | **Scraping frágil** (Puppeteer + seletores manuais) | Quebra quando o portal Paymobi muda |

**Maior ganho possível:** mover a orquestração para o backend (AgentCore) + tool-calling. Isso transforma o que hoje é um "auto-reply com etapas no browser" em um agente server-side que funciona 24/7.

---

## 2. Frameworks de agente — versões verificadas (npm, 07/10/2026)

| Framework | Versão latest | O que resolve | Recomendação |
|-----------|--------------|----------------|--------------|
| **Vercel AI SDK** (`ai`) | **7.0.130** | Camada de modelo: tool-calling, streaming, retries, multi-provider | ⭐ **Adotar primeiro** (menor atrito, TS-native, NIM é OpenAI-compatible) |
| `@ai-sdk/openai-compatible` | **3.0.65** | Provider para NVIDIA NIM (endpoint atual) | ⭐ Adotar junto |
| **Mastra** (`@mastra/core` / `mastra`) | **1.74.0 / 1.32.1** | Framework completo de agente (tools, memory, workflows, evals) | Opção "batteries-included" |
| **LangGraph** (`@langchain/langgraph`) | **1.4.20** | Máquina de estados em grafo para fluxos complexos (ex.: cobrança com aprovação humana) | Opção se complexidade crescer |
| **OpenAI Agents SDK** (`@openai/agents`) | **0.19.0** | SDK enxuto multi-provider | Alternativa |
| **MCP SDK** (`@modelcontextprotocol/sdk`) | **1.32.1** | Padronizar ferramentas (Paymobi, TTS, WhatsApp) como tools reutilizáveis | ⭐ Adotar na Fase 3 |
| **Langfuse** (`@langfuse/otel` + `@opentelemetry/sdk-node`) | **5.13.1** ✅ adotado (08/10/2026) | Tracing, custos e qualidade das decisões do LLM | O pacote `langfuse` (v3) está DEPRECADO — integração via OpenTelemetry (`backend/src/services/llmTracer.ts`); ativa só com LANGFUSE_* no .env |
| **LanceDB** (`@lancedb/lancedb`) | **0.40.0** ✅ adotado (08/10/2026) | Memória vetorial embarcada (zero-ops) | Módulo opt-in (`semanticMemory.ts`, AGENT_SEMANTIC_MEMORY=true); grava/busca atendimentos com embeddings do NIM |
| Qdrant (`@qdrant/js-client-rest`) | 1.19.0 | Vector DB em escala (servidor) | Se escalar |
| Chroma (`chromadb`) | 3.5.0 | Vector DB alternativa | Menos indicado p/ prod |
| **Playwright** (`playwright`) | **1.64.0** ✅ adotado (08/10/2026) | Automação de browser mais confiável que Puppeteer | Migração feita: PIX do scraper + E2E do painel (`npm run test:e2e`); puppeteer segue só como dep. do whatsapp-web.js |
| **Stagehand** (`@browserbasehq/stagehand`) | **4.1.0** | Automação de browser guiada por IA (resiliente a mudanças de DOM) | ⭐ Candidato para o scraping Paymobi |
| **Trigger.dev** (`@trigger.dev/sdk`) | **4.7.3** | Jobs duráveis gerenciados | Alternativa gerenciada ao BullMQ |

**Já tem no projeto:** BullMQ 6.3.11 (filas — usar para follow-ups/retries), Redis (sessão/memória curta).

**Adotado em 08/10/2026:** `ai@7.0.133` + `@ai-sdk/openai-compatible@3.0.66` — `AIService` (painel) e `AgentService.defaultChatCompletion` (agente) migrados para o Vercel AI SDK com provider compartilhado em `backend/src/services/aiProvider.ts`. O loop do agente (tool-calling, guards, takeover) foi mantido intacto; o smoke test com mocks e o teste de precisão com LLM real passaram. Testes: `npx tsx tests/_ai_smoke.ts` (painel) e `npx tsx tests/_agent_precision.ts` (agente, NIM real).

---

## 3. Electron vs Tauri (se o painel virar app desktop)

| Critério | Electron **44.6.0** (+ electron-builder **26.15.3**) | Tauri **2.12.1** (@tauri-apps/api 2.12.1) |
|----------|--------------------------------|------------------------------|
| Tamanho do bundle | ~150 MB (Chromium + Node embutidos) | ~5–15 MB (WebView do SO) |
| Backend Node.js | Embute Node (fácil portar) | Precisa sidecar Node/Python embutido |
| Segurança | Exige hardening manual | Mais seguro por padrão |
| WhatsApp/Puppeteer | Precisa do Chromium do Puppeteer (não reaproveita) | Idem (melhor manter no servidor) |

**Recomendação:**
1. **PWA primeiro** (custo zero — o painel já é web).
2. Se desktop for requisito: **Tauri 2.12.1** para a UI (leve/seguro) + backend continuando como serviço.
3. **Electron** só se precisar distribuir o backend Node inteiro embutido num único instalador.
4. **Não** rodar a automação WhatsApp/Puppeteer dentro do app desktop.

---

## 4. Rust — quando faz sentido (e quando não)

**NÃO recomendado agora:** reescrever o core. O `whatsapp-web.js` (automação WhatsApp Web multi-device) não tem equivalente Rust maduro — a busca no crates.io só retorna clientes da **Cloud API oficial**:
- `whatsapp` 0.8.1, `whatsapp_handler` 0.2.0 (Cloud API — exigiria mudar todo o fluxo e pagar por conversa)

**Adoção incremental futura (via napi-rs 3.10.8 / crate `napi` 3.14.2):**
- Pré-processamento de imagem/OCR (crate `tesseract` 0.15.2) — se OCR virar gargalo
- Conversão/resample de áudio — se o TTS Python virar gargalo
- Microserviços com `axum` 0.8.9 + `tokio` 1.53.2 — se houver necessidade real de split
- `tauri` 2.12.1 — só no cenário desktop

**Custo/benefício:** alto custo, ganho imediato baixo. Priorizar a arquitetura do agente antes.

---

## 5. Atualizações aplicadas nesta rodada (instaladas e validadas)

### Frontend
| Pacote | Antes | Depois |
|--------|-------|--------|
| react / react-dom | 19.2.6 | **19.3.0** |
| vite | 8.0.13 | **8.3.3** (rolldown 1.2.12) |
| framer-motion | 12.38.0 | **14.0.0** |
| lucide-react | 1.16.0 | **1.52.0** |
| eslint | 10.4.0 | **10.12.0** |
| tailwindcss | 3.4.19 | **4.3.3** (migração completa) |
| @tailwindcss/postcss | 4.3.0 | **4.3.3** |
| autoprefixer | 10.5.0 | **removido** (nativo no Tailwind 4) |
| concurrently | 9.2.1 | **10.0.5** |
| vite-plugin-checker | 0.8.0 | **0.14.5** |
| socket.io-client | 4.8.3 | **4.8.4** |
| tailwind-merge | 3.6.0 | **3.7.0** |
| @types/node | 22.x | **24.19.1** (alinhado ao runtime Node 24 LTS) |
| typescript | 5.9.3 | **7.0.2** (tsc nativo) + alias `typescript@npm:@typescript/typescript6@6.0.2` para a API do ESLint |

### Backend
| Pacote | Antes | Depois |
|--------|-------|--------|
| zod | 3.25.76 | **4.6.5** |
| pino / pino-pretty | 9.14 / 13.1.3 | **10.4.0 / 13.2.0** |
| ioredis | 5.10.1 | **6.0.0** |
| bullmq | 5.76 | **6.3.11** |
| dotenv | 17.4.2 | **18.0.6** (`quiet`) |
| axios | 1.16.1 | **1.20.0** |
| @gradio/client | 2.2.0 | **2.7.1** |
| tsx | 4.19.0 | **4.23.15** |
| socket.io | 4.8.3 | **4.8.4** |
| typescript | 5.9.3 | **7.0.2** |
| @types/node | 22.x | **24.19.1** |
| puppeteer | 24.38.0 | **24.43.1** (mantido em 24.x — `whatsapp-web.js` fixa 24.38.0; ir para 25 duplicaria o download do Chrome) |

### Migração Tailwind 3 → 4 (detalhes)
- `postcss.config.js`: agora usa somente `@tailwindcss/postcss` (autoprefixer removido)
- `src/index.css`: `@import 'tailwindcss'` + animações movidas para `@theme` + camada de compat de `border-color`
- `tailwind.config.js` removido (substituído pelo CSS-first; backup em `/tmp/kilo/backup`)
- Utilitários renomeados no código: `shadow-sm→shadow-xs`, `backdrop-blur-sm→backdrop-blur-xs`, `outline-none→outline-hidden`, `bg-gradient-to-r→bg-linear-to-r`

### TypeScript 7 side-by-side (mecanismo oficial)
Conforme o anúncio do TS 7.0 (devblogs.microsoft.com/typescript), o TS 7 não expõe API programática ainda; ferramentas como typescript-eslint usam a API via alias:
```json
"typescript": "npm:@typescript/typescript6@^6.0.2",   // API TS6 para o ESLint
"@typescript/native": "npm:typescript@^7.0.2"          // tsc nativo 7.0
```
- `npx tsc` → **7.0.2** | `npx tsc6` → **6.0.3**
- Quando o typescript-eslint suportar TS 7.1+, remover o alias.

### Verificações executadas
- ✅ `tsc --noEmit` (TS 7) — frontend e backend sem erros
- ✅ Build backend (tsc) e frontend (vite/tailwind 4) sem erros
- ✅ Lint frontend: 0 erros
- ✅ Smoke funcional com deps novas: config(zod4), logger(pino10), ChatState/Analytics (ioredis6), Paymobi guard + mascaramento de CPF (verificado no log: `123.***.***-**`), BullMQ 6 import

---

## 6. Roadmap recomendado para autonomia

| Fase | Ação | Ferramentas |
|------|------|-------------|
| **1** (1–2 sem) | Mover orquestração dos hooks do frontend → **AgentCore no backend**; tool-calling (consultarPaymobi, enviarMensagem, gerarAudio, historicoChat) | `ai@7` + `@ai-sdk/openai-compatible@3` |
| **2** | Memória (Redis + LanceDB) + tracing de decisões + filas de follow-up | `@lancedb/lancedb`, `@langfuse/otel`, BullMQ 6 (já instalado) |
| **3** | Scraping Paymobi resiliente + tools padronizadas | `@browserbasehq/stagehand` ou Playwright; `@modelcontextprotocol/sdk` |
| **4** (opcional) | Painel desktop (PWA → Tauri) e otimizações Rust (napi-rs) | `@tauri-apps/cli@2`, `@napi-rs/cli@3` |

---

## 7. Notas e riscos

- **typescript-eslint** ainda não suporta a API do TS 7.0 — mitigado com o alias oficial TS6 (acima).
- **Tailwind 4**: migração validada por build + classes no CSS final; recomenda-se um **QA visual** do painel (não 100% verificável sem navegador).
- **WhatsApp Web não oficial**: risco contínuo de quebra — manter versão do whatsapp-web.js fixada e monitorada.
- **Chrome/Puppeteer**: cache local de browsers vazio neste ambiente (`~/.cache/puppeteer`); em produção rodar `npx puppeteer browsers install chrome` se necessário.
