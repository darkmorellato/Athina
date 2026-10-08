# 🤖 Modelos de IA (Open-Source) e Operação do Agente
**Projeto:** Agent-Athina — atendimento WhatsApp sobre financiamento de celulares Nuovopay  
**Data:** 07/10/2026  
**Status:** implementado e testado (TTS + loop do agente com tool-calling)

---

## 1. TTS (voz) — open-source, português, rápido

### Decisão: **Kokoro-82M** (já integrado — mantido)
| Critério | Kokoro-82M | Piper | XTTS-v2 (Coqui) | Chatterbox Multilingual |
|----------|-----------|-------|-----------------|--------------------------|
| Licença | **Apache-2.0** ✅ | MIT ✅ | CPML ❌ (não comercial) | MIT ✅ |
| Tamanho | 82M (~325MB ONNX) | ~20–60MB | ~1.8B | ~0.5B |
| Português | ✅ vozes `pf_dora` (F), `pm_alex`, `pm_santa` (M) | ✅ `pt_BR`: cadu, edresson, faber, jeff (verificado no HF) | ✅ | ✅ (23 idiomas) |
| Velocidade (CPU) | **~5× tempo real** (medido: 12s de áudio em 2,4s) | ~10× tempo real | ~0,1× (GPU ideal) | ~1× (GPU ideal) |
| Qualidade | Alta para 82M | Média | Alta | Alta |

**Resultado do teste real (neste projeto):**
```
POST /tts {"text":"Olá! Encontramos o seu contrato...","voice":"pf_dora","format":"ogg"}
→ {"success":true,"filePath":"/tmp/local_tts_....ogg","durationMs":2459}
```
Saída OGG/Opus direto para nota de voz do WhatsApp. **Não há motivo para trocar** — Kokoro é a melhor relação qualidade/velocidade/licença para pt-BR em CPU. Piper fica como alternativa ultra-leve (troca simples: novo servidor `/tts`).

> MeloTTS não suporta português. F5-TTS sem pt oficial. XTTS descartado por licença não-comercial.

---

## 2. Modelos de raciocínio (LLM) open-source — respostas + envio de boletos

### Decisão: **Qwen3** (primário)
Verificado no Ollama (07/10/2026): **tools + thinking, 100+ idiomas (inclui pt-BR)**, tamanhos com contexto:

| Modelo | Tamanho | Contexto | Uso recomendado |
|--------|---------|----------|-----------------|
| `qwen3:4b` | 2.5 GB | 256K | Máquina modesta (8–12GB RAM, CPU) |
| **`qwen3:8b`** | **5.2 GB** | **40K** | **Recomendado: melhor custo/benefício (16GB RAM)** |
| `qwen3:14b` | 9.3 GB | 40K | Mais qualidade (GPU 12GB+ recomendada) |
| `qwen3:30b` (MoE) | 19 GB | 256K | Alta qualidade (GPU 24GB+) |

**Alternativas:** Gemma 3 (multilíngue forte) · Mistral Small (Apache-2.0, function calling) · DeepSeek-R1 distills (raciocínio puro, mas **fraco em tool-calling** — não indicado para o núcleo do agente).

### Como servir (OpenAI-compatible — o backend já fala essa API)
```bash
# 1. Instalar Ollama: https://ollama.com/download
ollama pull qwen3:8b

# 2. backend/.env
AI_BASE_URL=http://127.0.0.1:11434/v1
AI_API_KEY=ollama
AI_MODEL=qwen3:8b
AGENT_MODEL=qwen3:8b
AGENT_AUTOREPLY=true
```
Alternativas: `llama.cpp --server`, vLLM, ou manter NVIDIA NIM (nuvem) sem mudar nada.

---

## 3. O que foi implementado

### 3.1 `AgentService` — agente autônomo server-side
- Funciona **sem o painel aberto** (`AGENT_AUTOREPLY=true`).
- **Tool-calling** (OpenAI function calling): ferramenta `consultar_financiamento` (CPF/CNPJ/IMEI → Paymobi) — o modelo decide quando consultar e compõe a resposta com **parcela, vencimento, valor e CÓDIGO PIX copia-e-cola**.
- Memória de conversa por contato (LRU 500 contatos / 6h) + fila serializada por contato (sem respostas duplicadas).
- Deduplicação por ID de mensagem, timeouts, retry e fallbacks com log estruturado.
- Prompt de atendimento Nuovopay em pt-BR (cordato, nunca inventa dados, escala para humano em casos sensíveis).

### 3.2 Configuração de IA unificada
- `AIService` e `AgentService` usam `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` — funciona com **NVIDIA NIM, Ollama, llama.cpp ou vLLM** sem mudar código.
- `TTS_SERVER_URL` configurável (padrão `http://127.0.0.1:5050`).

### 3.3 Painel em modo monitor
- O backend avisa `agent-mode` ao conectar; se `AGENT_AUTOREPLY=true`, o painel **não responde** (evita resposta duplicada) e exibe aviso nos logs. Continua monitorando tudo em tempo real.

### 3.4 "Funciona ao ligar"
- `npm run setup:tts` cria o venv e instala Kokoro (uma vez).
- `npm run dev` sobe **frontend + backend + TTS** juntos (TTS usa o venv automaticamente).
- Health check agora reporta: estado do WhatsApp, Redis e **modo do agente** (`/health`).

---

## 4. Checklist para ligar a aplicação (do zero)

```bash
# 1. Dependências Node (frontend + backend)
npm install && npm --prefix backend install

# 2. TTS (uma única vez)
npm run setup:tts

# 3. Configurar credenciais
cp backend/.env.example backend/.env
#   → preencha: NVIDIA_API_KEY (ou AI_BASE_URL do Ollama),
#     PAYMOBI_EMAIL/PAYMOBI_PASSWORD, ADMIN_SECRET

# 4. (Opcional, recomendado p/ autonomia) modelo local
ollama pull qwen3:8b
#   → e no .env: AI_BASE_URL=http://127.0.0.1:11434/v1, AGENT_AUTOREPLY=true

# 5. Ligar tudo
npm run dev
#   Frontend: http://127.0.0.1:5173 · Backend: http://localhost:3001 · TTS: http://127.0.0.1:5050

# 6. Escanear o QR do WhatsApp no painel → pronto para atender
```

**Verificações rápidas:**
```bash
curl http://localhost:3001/health          # whatsapp/redis/agent
curl -X POST http://127.0.0.1:5050/tts \
  -H 'Content-Type: application/json' \
  -d '{"text":"Teste de voz","voice":"pf_dora","format":"ogg"}'
```

---

## 5. Testes executados nesta rodada
| Teste | Resultado |
|-------|-----------|
| TTS pt-BR (Kokoro `pf_dora`, OGG/Opus) | ✅ 12s de fala em 2,46s (~5× tempo real) |
| Loop do agente com LLM mockado (tool-calling) | ✅ CPF `123.456.789-01` → tool `consultar_financiamento("12345678901")` → resposta final com PIX enviada ao contato |
| Guardas (fromMe, broadcast, grupos, dedupe, fila por contato) | ✅ implementados |
| `tsc` + build backend (TS7) e frontend | ✅ sem erros |
| Health check com modo do agente | ✅ |

---

## 6. Próximos passos sugeridos (autonomia nível 2)
1. Enviar o **QR Code PIX como imagem** (o `paymobiPixProcessor` já gera `qrCodePath`) junto/em vez do código copia-e-cola.
2. Ferramentas adicionais: `reagendar_lembrete` (BullMQ), `registrar_promessa_pagamento`, `transferir_para_humano`.
3. Avaliação com Langfuse (traces das decisões) e métricas de resolução automática.
4. Fallback automático: se o modelo local estiver fora, usar NIM (`AI_FALLBACK_BASE_URL`).
