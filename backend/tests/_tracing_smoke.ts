/**
 * Smoke do tracing (Langfuse/OTel): com chaves FAKE, a inicialização não
 * quebra e uma chamada real de LLM continua respondendo — o export é
 * assíncrono e uma credencial inválida não afeta a resposta.
 *
 * Uso: npx tsx tests/_tracing_smoke.ts
 */
import assert from 'node:assert/strict';

// Env lido em tempo de chamada (ver llmTracer.ts).
process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-smoke-fake';
process.env.LANGFUSE_SECRET_KEY = 'sk-lf-smoke-fake';

import aiService from '../src/services/AIService.js';
import { initLlmTracing, isLlmTracingEnabled } from '../src/services/llmTracer.js';

assert.equal(isLlmTracingEnabled(), true, 'tracing deveria estar ligado com as chaves fake');
initLlmTracing();

const reply = await aiService.call({
  model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
  persona: 'Responda em português brasileiro, de forma curta.',
  message: 'Diga apenas: ok',
  contactId: 'smoke-tracing',
});
assert.ok(reply.length > 0, 'a resposta deveria chegar normalmente com tracing ligado');

console.log('  ✔ tracing inicializado sem quebrar; resposta com telemetry:', JSON.stringify(reply).slice(0, 60));
console.log('\nTracing smoke: 1/1 cenários passaram');

// O SDK OpenTelemetry mantém handles ativos — encerra explícito.
process.exit(0);
