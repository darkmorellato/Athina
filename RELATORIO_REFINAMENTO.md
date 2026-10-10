# Relatório de Refinamento — Agent-Athina
**Data:** 10/10/2026 · **Escopo:** codebase completa (backend Node/TS, painel React, TTS Python) · **Método:** auditoria profissional em 4 frentes (backend, UI/WhatsApp Web, voz, stack/HA), correções aplicadas em ordem de severidade e verificadas por execução real.

---

## 1. Resultado em números (tudo verificado com saída real)

| Verificação | Resultado |
|---|---|
| Backend typecheck (`tsc`) | ✅ 0 erros |
| Smoke do agente autônomo | ✅ 12/12 cenários (exit 0, ~24s) |
| Testes do normalizador pt-BR | ✅ 26/26 casos |
| Frontend typecheck + build | ✅ 0 erros (build 465ms) |
| Vitest (componentes) | ✅ 34/34 (5 arquivos) |
| Lint (backend+frontend) | ✅ 0 erros · 73 warnings (linha de base pré-existente, sem novos) |
| **UI no Chromium real** (com backend mock) | ✅ **12/12 checks** (recibos, scroll/FAB, composer, emoji) |
| Voz ponta-a-ponta | ✅ leitura crua **idêntica** à expandida: `R$ 1.234,56` 4,14s = 4,14s; frase completa 10,92s = 10,92s (antes: 3,78s falando "dólar" e 13,80s com "asterisco/menos zero um") |

Commits: `931058e` (voz pt-BR), `4fb7060` (hardening backend 24/7), `bccd442` (UI fidelidade WhatsApp) — + este relatório.

---

## 2. O que foi corrigido

### 2.1 Voz (pt-BR: tom, fonética, ortografia)
- **`backend/tts_normalize.py` (novo)** — normalização determinística aplicada no `ttsServer.py` para **todos** os providers (Kokoro, Chatterbox, Magpie):
  - `R$ 1.234,56` → "mil duzentos e trinta e quatro reais e cinquenta e seis centavos" (o espeak falava **"dólar"**);
  - CPF/CNPJ formatados → dígito a dígito em grupos ("um dois três, quatro cinco seis…"); IMEI/telefone idem (nunca "menos quatro mil");
  - datas `dd/mm(/aaaa)` → "cinco de novembro de dois mil e vinte e seis"; horas `14:30`/`14h30` → "catorze horas e meia";
  - `24x` → "vinte e quatro vezes"; `%` → "por cento"; emojis/markdown/URLs removidos (emoji virava "rosto sorridente…" falado); código PIX copia-e-cola nunca é ditado (vira "código");
  - léxico: `PIX`→"pix" (espeak soletrava "pê i xis"), `WhatsApp`→"Uatsapi", `site`→"sáite"; máscara `***.456.789-**` neutralizada;
  - idempotente, à prova de exceção; escape hatch `"normalize": false`.
- **`ttsServer.py`**: pausas naturais (`sentence_pause=0.35`, `clause_pause=0.12`); truncagem na fronteira de frase com flag `truncated`; resposta devolve `provider` e `voiceUsed`; `riva_female` aponta para a Magpie feminina (antes caía silenciosamente numa voz masculina).
- **`TTSService.ts`**: timeout 30s→120s (textos longos estouravam).
- Painel: opção 🎙️ Alex (voz masculina **local** `pm_alex`); prompt do botão "Revisar" ampliado com as regras de fala.
- Dependência `num2words` adicionada ao `setup:tts`.

### 2.2 Backend (gargalos, más práticas, riscos — 24/7)
- **🔴 CRÍTICO — Socket.IO sem autenticação** → gate no handshake: com `ADMIN_SECRET`, exige token (o painel já o envia); sem segredo, só loopback. Elimina o "qualquer cliente na porta recebe o QR/histórico e envia mensagens".
- **PII em logs (LGPD)** → `utils/redact.ts` + mascaramento em Paymobi (IMEI/nome/CPF raspado) e mensagens (telefone); log de boleto removido.
- **Sessão do WhatsApp**: limpeza só na 5ª falha de init (antes 3ª ~15s forçava novo QR e tirava o bot do ar); kill de zumbis assíncrono (não bloqueia o loop); **watchdog de sessão** (getState a cada 5min).
- **Agente**: deadline global por mensagem (180s libera a fila do contato — pior caso teórico era ~30min); timeout do LLM 45s/tentativa (antes 120s); cooldown de fallback gravado só após envio ok; regex de documento não dispara mais com telefone em frase; `searchType` cnpj.
- **Paymobi**: match **exato** de CNPJ (evitava entregar contrato de outro titular); não fecha mais o browser compartilhado em erro de PIX (derrubava consultas concorrentes).
- **Mídia inbound**: teto de 5MB (antes um documento de 100MB virava ~133MB de base64 em memória/socket); flag `mediaOmitted`.
- **Redis**: reconexão contínua via watchdog unref'd (religa sozinho; não trava mais scripts/testes — ver §5).
- **Analytics**: hidrata do espelho SQLite quando o Redis perde a chave (contadores não "zeram" mais).
- **Infra**: `/live` para supervisores (reconexão do WhatsApp não reinicia o serviço); probe de TTS cacheado; `TRUST_PROXY`; `uncaughtException` encerra em produção; avatares em LRU 5000 com invalidação no READY; rotação de screenshots de debug (72 PNGs antigos arquivados fora do repo); loop "Use here" para após clicar; `send-failed` avisa no painel quando o WhatsApp não está pronto (antes descarte silencioso); modo áudio por socket (um operador não muda o envio dos outros).

### 2.3 Interface (fidelidade WhatsApp Web + UX + performance)
- **Recibos reais** (top-2 da auditoria): backend escuta `message_ack` do whatsapp-web.js → evento `message-ack` → bolha mostra 🕓 → ✓ → ✓✓ → **✓✓ azul** (token `--WDS-content-read #007BFC`, que existia e nunca era usado).
- **Scroll como no WA**: não arranca mais a tela quando chega mensagem em outra conversa (autoscroll só se o usuário está no fim) + **botão "ir para o fim" com badge** de novas mensagens.
- **"digitando…"** virou bolha recebida branca + status no cabeçalho (antes bolha verde de saída).
- **Composer fiel**: botão **enviar dentro da pílula**; emoji inserido **na posição do cursor**; picker fecha com **ESC/clique fora**; aria-labels.
- **Performance**: memo do ChatView destravado (prop inline que re-renderizava a conversa a cada tecla), `buildTimeline` memoizado, `WhatsAppPanel`/`ContactList` com memo, console de execução rola só o próprio container.
- **Acessibilidade**: lista de conversas `listbox/option` com teclado (Enter/Espaço), região de mensagens `role="log"`, busca com ESC/aria.
- **Tokens atualizados ao vivo**: verde de ação `#24D366` → **`#1DAA61`** (accent real de 10/2026); paleta oficial de avatar (`--WDS-components-profile-photo-*`) por hash do contato; hora da mensagem derivada do timestamp real.

---

## 3. Análise profissional — principais achados por frente

**Backend (25 achados, resumo dos prioritários além dos corrigidos):**
- fila por contato sem deadline (corrigido); CNPJ sem match exato (corrigido); mídia sem teto (corrigido);
- ainda abertos: dedupe/fila em memória por processo + Socket.IO sem adapter Redis limitam escala horizontal (documentar SPOF da sessão única); `pendingData` com `z.any()` (schema estrito pendente); screenshots futuros agora rotacionam, mas revisar retenção de `boletoUrl` no payload; código morto (`PaymobiQueueService`, deps não usadas).

**Frontend (51 achados; 16 resolvidos nesta rodada):**
- resolvidos: re-render do chat (#1), buildTimeline (#3), scroll (#7), memo da lista (#8), teclado (#9), role=log (#11), console (#12), emoji/ESC (#14), hora real (#21), ticks/ack (#24), FAB (#34), "digitando" (#38), sub do header (#39), composer pílula (#44 parcial), avatar fallback (#47 parcial).
- restantes prioritários (roadmap §4): virtualização do chat (#2), índices O(1)/estado normalizado (#4–6), busca por conteúdo e na conversa (#25–26), painel de perfil (#27), menu de contexto/ações (#28–32), não-lidas (#33), gravação de áudio no composer (#37), lightbox de imagem (#13), linkificação/formatação (#41), datas sticky (#40), Roboto na sidebar (#46), lazy decode de áudio (#20).

**Voz (18 achados):** núcleo resolvido (normalização completa + parâmetros + auditoria de provider). Restante: avaliação por escuta humana das amostras (`backend/debug/`, `.tts_tmp`), opcional Piper como 2º fallback local.

---

## 4. Roadmap priorizado (o que falta)

1. **Não-lidas** (backend `chat.unreadCount` → badge verde + divisória + hora verde) — alto impacto visual.
2. **Busca completa** (conteúdo de mensagens + dentro da conversa) e **painel de perfil** do contato.
3. **Menu de contexto + ações**: responder/copiar/encaminhar/editar/apagar para todos/favoritar, fixar/arquivar/silenciar (requer eventos novos no contrato).
4. **Virtualização do ChatView + estado normalizado por conversa** (escala para milhares de mensagens).
5. **Gravação de áudio no composer** (mic/timer/cancelar) — fecha o gap de composer.
6. Lightbox de imagem, reações, picker completo (emoji-mart), seleção múltipla, placeholder de apagada/editada.
7. Backend: schema estrito de `pendingData`, idempotência da fila por messageId em Redis (escala), remover código morto.

---

## 5. Stack para atendimento 24/7 (recomendações pesquisadas em 10/10/2026, com versões verificadas)

**ADOTAR AGORA (barato, alto impacto):**
1. **Sair do pin `github#main`**: fixar `whatsapp-web.js@1.34.7` (release estável; a main gera pré-releases sem rollback) — `npm install whatsapp-web.js@1.34.7` (https://github.com/wwebjs/whatsapp-web.js/releases).
2. **LocalAuth com dataPath fixo fora do repo + backup diário** do diretório de sessão (perder = novo QR manual) (https://wwebjs.dev/guide/creating-your-bot/authentication.html).
3. **webVersionCache remoto** (wa-version) para pinar a build do WhatsApp Web e poder reverter quando uma build nova quebrar a lib (https://github.com/wppconnect-team/wa-version).
4. **Supervisor único**: systemd (`Restart=always`, `KillMode=control-group`, `EnvironmentFile`) **ou** pm2 7.0.4 (backoff/memory/cron) — nunca os dois no mesmo processo. Use `/live` (já exposto) como liveness (https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html).
5. **Monitoração**: Uptime Kuma 2.5.5 apontando para `/health` (que já checa WhatsApp/Redis/TTS) + **Healthchecks.io** (dead-man switch externo — o único que detecta a máquina inteira caída) (https://healthchecks.io/pricing/).
6. **Sentry** (`@sentry/node` 11.6.0, plano Developer grátis) para crashes de Node/puppeteer; Langfuse cobre só LLM (https://sentry.io/pricing/).
7. **Litestream 0.5.17** para backup contínuo do SQLite (WAL) + ensaio de restore mensal (https://litestream.io/getting-started/).
8. **Redis com AOF + noeviction** (quando adotar) e BullMQ 6.3.12 com shutdown por SIGTERM e idempotência por messageId (https://docs.bullmq.io/guide/going-to-production).
9. **Circuit breaker** (opossum 10) nas chamadas LLM/TTS com degradação para texto (https://www.npmjs.com/package/opossum).

**PRÓXIMO (1–3 meses, decidir com dados):** adaptador para a **WhatsApp Cloud API oficial** como rota de zero-banimento — no Brasil, desde 01/10/2026 service messages custam R$0,035 após 1.000 grátis/mês por número (ex.: 10k msg/mês ≈ R$315); mensagens cliente→empresa nunca são cobradas; CTWA dá até 7 dias grátis (https://developers.facebook.com/docs/whatsapp/pricing). RemoteAuth só com 2ª máquina; BullMQ sobre Postgres se adotar Postgres.

**NUNCA:** pin de branch main em produção; LiteFS (sem suporte do Fly, pré-1.0); self-host do Langfuse v3 na máquina do atendimento (ClickHouse 8GB+); Baileys 7.0.0-rc como base; endpoints free do NIM como pilar (licença de produção exige NVIDIA AI Enterprise); dois supervisores no mesmo processo.

**Notas do ambiente:** máquina roda Node **v26.7.0** (current) — para produção, preferir **Node 24 LTS** (campo `engines` + `.nvmrc`). VS Code/dev: otimizado para operador único local; o ponto único (SPOF) é a sessão única do WhatsApp — documentar e monitorar.

---

## 6. Checklist de produção (configuração)

- [ ] `backend/.env`: `NODE_ENV=production`, `ALLOWED_ORIGIN=https://<painel>`, `ADMIN_SECRET` (openssl rand -hex 32) e token no painel, `AGENT_AUTOREPLY=true` para autonomia 24/7, `TRUST_PROXY` se atrás de nginx.
- [ ] Supervisor (systemd/pm2) apontando para `/live`; restart automático habilitado.
- [ ] Backup: `.wwebjs_auth` (diário) + SQLite via Litestream; restore ensaiado.
- [ ] Monitoração: Uptime Kuma (`/health`) + Healthchecks externo + Sentry.
- [ ] Amostras de voz revisadas por escuta humana (tom/dicção) antes de ligar o modo áudio em produção.

## 7. Comandos de verificação rápida

```bash
cd ~/Codes/Agent-Athina
npm run typecheck && npm run test && npm run build && npm run lint     # painel
npm --prefix backend run typecheck && npm --prefix backend test        # backend
backend/.venv/bin/python backend/tests/test_tts_normalize.py           # voz pt-BR
curl -s localhost:3001/health | python3 -m json.tool                   # prontidão
curl -s localhost:3001/live                                           # liveness
curl -s -X POST localhost:5050/tts -H 'Content-Type: application/json' \
  -d '{"text":"Seu boleto de R$ 89,90 vence em 05/11/2026.","voice":"pf_dora","format":"ogg"}'
```
