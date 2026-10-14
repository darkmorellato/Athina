/**
 * @fileoverview Leitura e classificação (PIX vs. boleto) de comprovante de
 * pagamento recebido no fluxo de "celular bloqueado".
 *
 * Pipeline:
 *  1. PDF → converte a primeira página em PNG (pdftoppm).
 *  2. OCR hospedado da NVIDIA (nemotron-ocr-v2) lê o texto da imagem.
 *  3. Regra fixa sobre o texto decide PIX ou BOLETO.
 *  4. Se o texto não bastar (foto ruim, layout estranho), um modelo de visão
 *     da NVIDIA (llama-3.2-90b-vision-instruct) classifica a imagem.
 *
 * Sem chave de API, ou se tudo falhar, retorna INDEFINIDO e o comprovante
 * segue para o atendente humano.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import axios from 'axios';
import config from '../../config/index.js';
import logger from '../../utils/logger.js';

const execFileAsync = promisify(execFile);

/** Teto de tamanho da mídia baixada (base64) — evita carregar arquivo gigante. */
const MAX_MEDIA_BASE64_CHARS = 5 * 1024 * 1024;

const NVIDIA_CV_ENDPOINT = 'https://ai.api.nvidia.com/v1/cv';
const NVIDIA_CHAT_ENDPOINT = 'https://integrate.api.nvidia.com/v1/chat/completions';

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

interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
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

const BOLETO_PATTERN =
  /\b(boleto|c[oó]digo de barras|linha digit[aá]vel|ficha de compensa[cç][aã]o|pagamento de t[ií]tulos?)\b/i;
const PIX_PATTERN = /\bpix\b/i;

/**
 * Regra fixa sobre o texto do comprovante. Boleto vem antes: comprovantes de
 * boleto costumam citar "pix" no rodapé (aviso genérico do banco).
 */
export function classifyReceiptText(text: string): ReceiptKind {
  if (BOLETO_PATTERN.test(text)) return 'BOLETO';
  if (PIX_PATTERN.test(text)) return 'PIX';
  return 'INDEFINIDO';
}

/** Lê o texto da imagem com o OCR da NVIDIA. Retorna null se a chamada falhar. */
async function ocrImage(imageBase64: string, mimetype: string): Promise<string | null> {
  const apiKey = config.aiApiKey;
  if (!apiKey) return null;
  try {
    const response = await axios.post<NvidiaOcrResponse>(
      `${NVIDIA_CV_ENDPOINT}/${config.agentVisionModel}`,
      { input: [{ type: 'image_url', url: `data:${mimetype};base64,${imageBase64}` }] },
      {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 20_000,
      }
    );
    const detections = response.data?.data?.[0]?.text_detections ?? [];
    return detections.map((d) => d.text_prediction?.text ?? '').join(' ').trim();
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err), status: axios.isAxiosError(err) ? err.response?.status : undefined },
      '[ReceiptAnalysis] OCR da NVIDIA falhou'
    );
    return null;
  }
}

/** Classifica a imagem com o modelo de visão da NVIDIA (reserva do OCR). */
async function visionClassify(imageBase64: string, mimetype: string): Promise<ReceiptKind> {
  const apiKey = config.aiApiKey;
  if (!apiKey) return 'INDEFINIDO';
  try {
    const response = await axios.post<ChatResponse>(
      NVIDIA_CHAT_ENDPOINT,
      {
        model: config.receiptVisionModel,
        temperature: 0,
        max_tokens: 60,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  'Esta imagem é um comprovante de pagamento. Responda somente com uma palavra: ' +
                  'PIX se for comprovante de transferência PIX, BOLETO se for comprovante de pagamento ' +
                  'de boleto ou título (código de barras), ou INDEFINIDO se não der para saber.',
              },
              { type: 'image_url', image_url: { url: `data:${mimetype};base64,${imageBase64}` } },
            ],
          },
        ],
      },
      {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 25_000,
      }
    );
    const answer = (response.data?.choices?.[0]?.message?.content ?? '').toUpperCase();
    if (/\bBOLETO\b/.test(answer)) return 'BOLETO';
    if (/\bPIX\b/.test(answer)) return 'PIX';
    return 'INDEFINIDO';
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      '[ReceiptAnalysis] Modelo de visão falhou — seguindo como INDEFINIDO'
    );
    return 'INDEFINIDO';
  }
}

/** Converte a primeira página de um PDF em PNG (base64). Retorna null se falhar. */
async function pdfFirstPageToPng(pdfBase64: string): Promise<string | null> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'athina-receipt-'));
  const pdfPath = path.join(dir, 'receipt.pdf');
  const outPrefix = path.join(dir, 'page');
  try {
    await fs.writeFile(pdfPath, Buffer.from(pdfBase64, 'base64'));
    await execFileAsync('pdftoppm', ['-png', '-r', '150', '-f', '1', '-l', '1', '-singlefile', pdfPath, outPrefix], {
      timeout: 20_000,
    });
    const png = await fs.readFile(`${outPrefix}.png`);
    return png.toString('base64');
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      '[ReceiptAnalysis] Não consegui converter o PDF (pdftoppm)'
    );
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Classifica o comprovante como PIX, BOLETO ou INDEFINIDO. PDFs são analisados
 * pela primeira página. Sem chave de API, ou sem resposta confiável, o
 * resultado é INDEFINIDO e o atendente humano decide.
 */
export async function classifyReceipt(media: DownloadedMedia): Promise<ReceiptKind> {
  let imageBase64: string | null = null;
  let imageMime = media.mimetype;

  if (media.mimetype === 'application/pdf') {
    imageBase64 = await pdfFirstPageToPng(media.base64);
    imageMime = 'image/png';
  } else if (media.mimetype.startsWith('image/')) {
    imageBase64 = media.base64;
  }
  if (!imageBase64) return 'INDEFINIDO';

  const text = await ocrImage(imageBase64, imageMime);
  const fromText = text ? classifyReceiptText(text) : 'INDEFINIDO';
  if (fromText !== 'INDEFINIDO') return fromText;

  return visionClassify(imageBase64, imageMime);
}
