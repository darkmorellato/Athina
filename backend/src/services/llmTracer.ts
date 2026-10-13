/**
 * @fileoverview Tracing opcional das chamadas de LLM (OpenTelemetry → Langfuse).
 *
 * Totalmente opt-in: sem `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` no
 * ambiente vira NO-OP (nada é iniciado, nada é exportado, zero overhead).
 * Com as chaves, um LangfuseSpanProcessor global exporta os spans gerados
 * pelo `telemetry` do Vercel AI SDK (ver AIService).
 *
 * Env: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY (obrigatórias p/ ativar),
 *      LANGFUSE_BASEURL (self-host; padrão = Langfuse Cloud).
 *
 * O ambiente é lido em TEMPO DE CHAMADA (permite ligar em runtime/testes).
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import logger from '../utils/logger.js';

function tracingEnabled(): boolean {
  return Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);
}

let started = false;

/** Inicia o exporter global UMA vez (no-op sem chaves). Chamar no boot. */
export function initLlmTracing(): void {
  if (started || !tracingEnabled()) return;
  try {
    const sdk = new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] });
    sdk.start();
    started = true;
    logger.info('Langfuse tracing ativo (OTel → Langfuse)');
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Falha ao iniciar tracing — seguindo sem'
    );
  }
}

export function isLlmTracingEnabled(): boolean {
  return tracingEnabled();
}

/** Opções `telemetry` para o generateText (inertes quando desligado). */
export function llmTelemetry(functionId: string): {
  isEnabled: boolean;
  functionId: string;
} {
  return { isEnabled: tracingEnabled(), functionId };
}
