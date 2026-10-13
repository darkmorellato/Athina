/**
 * @fileoverview Download e classificação (PIX vs. boleto) de comprovante de
 * pagamento recebido no fluxo de "celular bloqueado".
 *
 * Usa o NIM de OCR hospedado da NVIDIA (Nemotron OCR v2 — sucessor do NeMo
 * Retriever OCR) em vez de pedir a um modelo de chat para "olhar" a imagem:
 * é um modelo dedicado de leitura de texto, então a extração é mais confiável
 * do que pedir a um VLM genérico para classificar diretamente, e a
 * classificação final (PIX vs. boleto) fica como regra determinística sobre
 * o texto extraído — coerente com o resto do roteiro (AthinaFlowService), que
 * não deixa um LLM decidir a resposta.
 *
 * Endpoint confirmado manualmente (ver NVIDIA RAG Blueprint docs):
 * `https://ai.api.nvidia.com/v1/cv/<modelo>` — NÃO é o endpoint OpenAI-
 * compatible de chat/completions usado pelo resto do backend.
 *
 * Sem `AGENT_VISION_MODEL`/chave de API configurada, ou para PDFs (o OCR só
 * aceita image_url — png/jpeg), a análise automática fica desativada e o
 * comprovante segue direto para o atendente humano, sem classificação.
 */
import axios from 'axios';
import config from '../../config/index.js';
import logger from '../../utils/logger.js';

/** Teto de tamanho da mídia baixada (base64) — mesmo critério do broadcast em
 *  tempo real (`whatsappMessageHelper.ts`): evita carregar um arquivo gigante
 *  na memória do processo. */
const MAX_MEDIA_BASE64_CHARS = 5 * 1024 * 1024;

/** Base do endpoint de Computer Vision hospedado da NVIDIA (NIM). */
const NVIDIA_CV_ENDPOINT = 'https://ai.api.nvidia.com/v1/cv';

export type ReceiptKind = 'PIX' | 'BOLETO' | 'INDEFINIDO';

export interface DownloadedMedia {
  base64: string;
  mimetype: string;
}

interface DownloadableMessage {
  hasMedia?: boolean;
  downloadMedia: () => Promise<{ data: string; mimetype: string } | null | undefined>;
}

interface NvidiaOcrResponse {
  data?: Array<{
    text_detections?: Array<{ text_prediction?: { text?: string; confidence?: number } }>;
  }>;
}

/** Baixa a mídia de uma mensagem do WhatsApp, respeitando o teto de tamanho. */
export async function downloadMediaBounded(msg: DownloadableMessage): Promise<DownloadedMedia | null> {
  if (!msg.hasMedia) return null;
  try {
    const media = await msg.downloadMedia();
    if (!media?.data) return null;
    if (media.data.length > MAX_MEDIA_BASE64_CHARS) {
      logger.warn({ size: media.data.length }, '[ReceiptAnalysis] Mídia grande demais — não analisada');
      return null;
    }
    return { base64: media.data, mimetype: media.mimetype };
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      '[ReceiptAnalysis] Falha ao baixar mídia'
    );
    return null;
  }
}

/** Chama o OCR hospedado da NVIDIA e devolve o texto lido na imagem (ou null). */
async function extractReceiptText(media: DownloadedMedia): Promise<string | null> {
  const apiKey = config.aiApiKey;
  const model = config.agentVisionModel;
  if (!apiKey || !model) return null;

  try {
    const response = await axios.post<NvidiaOcrResponse>(
      `${NVIDIA_CV_ENDPOINT}/${model}`,
      { input: [{ type: 'image_url', url: `data:${media.mimetype};base64,${media.base64}` }] },
      {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 20_000,
      }
    );
    const detections = response.data?.data?.[0]?.text_detections ?? [];
    return detections
      .map((d) => d.text_prediction?.text ?? '')
      .join(' ')
      .trim();
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    const hint = status === 403 ? ' — confira NVIDIA_API_KEY e o acesso ao modelo em build.nvidia.com' : '';
    logger.warn(
      { error: err instanceof Error ? err.message : String(err), status },
      `[ReceiptAnalysis] Falha ao chamar o OCR da NVIDIA — seguindo como INDEFINIDO${hint}`
    );
    return null;
  }
}

const PIX_PATTERN = /\bpix\b/i;
const BOLETO_PATTERN = /\b(boleto|c[oó]digo de barras|linha digit[aá]vel|ficha de compensa[cç][aã]o)\b/i;

/**
 * Classifica o comprovante como PIX, BOLETO ou INDEFINIDO a partir do texto
 * lido pelo OCR da NVIDIA. Retorna INDEFINIDO sem chamar o modelo quando não
 * há chave/modelo configurado, a mídia não é imagem (ex.: PDF), ou o OCR não
 * lê nenhum termo reconhecível — nesses casos o comprovante só é encaminhado
 * ao atendente humano, sem classificação automática.
 */
export async function classifyReceipt(media: DownloadedMedia): Promise<ReceiptKind> {
  if (!media.mimetype.startsWith('image/')) return 'INDEFINIDO';

  const text = await extractReceiptText(media);
  if (!text) return 'INDEFINIDO';

  const isBoleto = BOLETO_PATTERN.test(text);
  const isPix = PIX_PATTERN.test(text);
  // Comprovantes de boleto costumam citar "pix" no rodapé (aviso genérico do
  // banco) — o termo de boleto/código de barras é o mais específico, então
  // decide primeiro.
  if (isBoleto) return 'BOLETO';
  if (isPix) return 'PIX';
  return 'INDEFINIDO';
}
