/**
 * @fileoverview Centralized configuration management with Zod validation.
 */
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. Try loading from the standard backend/.env path relative to this file
loadEnv({ path: path.resolve(__dirname, '../../.env'), quiet: true });

// 2. Fallback: try loading from the current working directory (e.g. if started inside backend/)
loadEnv({ path: path.resolve(process.cwd(), '.env'), quiet: true });

// 3. Fallback: try loading from backend/.env relative to current working directory (e.g. if started from root)
loadEnv({ path: path.resolve(process.cwd(), 'backend/.env'), quiet: true });

const envSchema = z.object({
  PORT: z.coerce.number().default(3001),
  NVIDIA_API_KEY: z.string().optional(),
  PAYMOBI_EMAIL: z.string().optional(),
  PAYMOBI_PASSWORD: z.string().optional(),
  PAYMOBI_LOGIN_URL: z
    .string()
    .url()
    .default('https://www.paymobi.com.br/views/modules/login_page.php'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  ADMIN_SECRET: z.string().optional(),
  RESEMBLE_API_KEY: z.string().optional(),
  RESEMBLE_SYNTHESIS_URL: z.string().url().optional(),
  RESEMBLE_STREAMING_URL: z.string().url().optional(),
  ALLOWED_ORIGIN: z.string().url().optional(),
  // AI provider (OpenAI-compatible). Default: NVIDIA NIM cloud.
  // For local open-source models: AI_BASE_URL=http://127.0.0.1:11434/v1 (Ollama)
  AI_BASE_URL: z.string().url().optional(),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().optional(),
  // Autonomous server-side auto-reply agent
  AGENT_AUTOREPLY: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  // Modelo de OCR hospedado da NVIDIA (https://ai.api.nvidia.com/v1/cv/<modelo>,
  // autenticado com NVIDIA_API_KEY/AI_API_KEY) usado para ler o comprovante de
  // pagamento (PIX vs. boleto) no fluxo de "celular bloqueado". Vazio = a
  // análise automática fica desativada e o comprovante só é encaminhado ao
  // atendente humano, sem classificação.
  AGENT_VISION_MODEL: z.string().optional(),
  // Modelo de visão (chat) usado quando o OCR não identifica o comprovante.
  RECEIPT_VISION_MODEL: z.string().default('meta/llama-3.2-90b-vision-instruct'),
  // Contatos humanos (WhatsApp) que recebem a transferência de atendimento —
  // dígitos com DDI+DDD separados por vírgula, ex.: "5519989354849,5519990151809".
  HUMAN_HANDOFF_CONTACTS: z.string().optional(),
  // Local TTS server (Kokoro ONNX)
  TTS_SERVER_URL: z.string().url().default('http://127.0.0.1:5050'),
  // Reverse proxy hops para o rate limit por IP (0 = exposição direta)
  TRUST_PROXY: z.coerce.number().min(0).max(10).default(0),
  // Modelo opcional de Speech-to-Text (OpenAI-compatible /audio/transcriptions) para notas de voz
  STT_MODEL: z.string().optional(),
  // Segredo HMAC opcional para o webhook de confirmação proativa de pagamento (/webhooks/payment)
  PAYMENT_WEBHOOK_SECRET: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Config validation error:', parsed.error.flatten().fieldErrors);
  throw new Error('Failed to validate environment variables.');
}

const env = parsed.data;

/** Normalize an OpenAI-compatible base URL (strip trailing slash / chat/completions) */
function normalizeAiBaseUrl(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
}

const DEFAULT_NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

const configObj = {
  port: env.PORT,
  nvidiaApiKey: env.NVIDIA_API_KEY ?? null,
  paymobiEmail: env.PAYMOBI_EMAIL ?? null,
  paymobiPassword: env.PAYMOBI_PASSWORD ?? null,
  paymobiLoginUrl: env.PAYMOBI_LOGIN_URL,
  nodeEnv: env.NODE_ENV,
  isDev: env.NODE_ENV === 'development',
  adminSecret: env.ADMIN_SECRET ?? null,
  resembleApiKey: env.RESEMBLE_API_KEY ?? null,
  resembleSynthesisUrl: env.RESEMBLE_SYNTHESIS_URL ?? null,
  resembleStreamingUrl: env.RESEMBLE_STREAMING_URL ?? null,
  allowedOrigin: env.ALLOWED_ORIGIN ?? null,
  aiBaseUrl: normalizeAiBaseUrl(env.AI_BASE_URL ?? DEFAULT_NVIDIA_BASE_URL),
  aiApiKey: env.AI_API_KEY ?? env.NVIDIA_API_KEY ?? null,
  aiModel: env.AI_MODEL ?? null,
  agentAutoReply: env.AGENT_AUTOREPLY,
  agentVisionModel: env.AGENT_VISION_MODEL ?? 'nvidia/nemotron-ocr-v2',
  receiptVisionModel: env.RECEIPT_VISION_MODEL,
  /** Dígitos de contato (sem @c.us) dos atendentes humanos — vazio se não configurado. */
  humanHandoffContacts: (env.HUMAN_HANDOFF_CONTACTS ?? '')
    .split(',')
    .map((s) => s.replace(/\D/g, ''))
    .filter((s) => s.length >= 10),
  ttsServerUrl: env.TTS_SERVER_URL,
  trustProxy: env.TRUST_PROXY,
  sttModel: env.STT_MODEL ?? null,
  paymentWebhookSecret: env.PAYMENT_WEBHOOK_SECRET ?? null,
} as const;

export default configObj;