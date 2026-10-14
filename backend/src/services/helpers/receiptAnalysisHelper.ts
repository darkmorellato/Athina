/**
 * @fileoverview Leitura e classificação (PIX vs. boleto) de comprovante de
 * pagamento recebido no fluxo de "celular bloqueado".
 *
 * Como decidimos (cliente pode induzir ao erro, então a regra é conservadora):
 *  1. PDF → primeira página vira PNG (pdftoppm). Imagem → usada direto.
 *  2. OCR da NVIDIA (nemotron-ocr-v2) extrai o texto.
 *  3. Evidências de BOLETO: linha digitável / código de barras de 44 dígitos
 *     (forte) ou termos como "pagamento de títulos" (médio).
 *     Evidências de PIX: ID de transação E2E (forte) ou a palavra "pix" (fraco,
 *     pois boletos costumam citar PIX no rodapé).
 *  4. Sinais de boleto E de PIX fortes ao mesmo tempo → INDEFINIDO (conflito).
 *  5. Se a análise por texto não for "alta" confiança, um modelo de visão da
 *     NVIDIA classifica a imagem; se ele discordar do texto → INDEFINIDO.
 *
 * INDEFINIDO vai para um atendente humano com os sinais encontrados.
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

export interface ReceiptAnalysis {
  kind: ReceiptKind;
  confidence: 'alta' | 'media' | 'baixa';
  /** Sinais encontrados, em português, para o atendente conferir. */
  evidence: string[];
}

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

// ─── Evidências ──────────────────────────────────────────────────────────────

/** Linha digitável do boleto (47 dígitos, com ou sem pontos e espaços). */
const LINHA_DIGITAVEL = /\b\d{5}\.?\d{5}\s?\d{5}\.?\d{6}\s?\d{5}\.?\d{6}\s?\d\s?\d{14}\b/;
/** ID de ponta a ponta do PIX: E + ISPB (8) + data/hora (12) + sufixo alfanumérico (11). */
const E2E_ID = /\bE\d{8}\d{12}[A-Za-z0-9]{11}\b/;
const BOLETO_TERMS = /\b(boleto|c[oó]digo de barras|linha digit[aá]vel|ficha de compensa[cç][aã]o|pagamento de t[ií]tulos?)\b/i;
const PIX_WORD = /\bpix\b/i;

/**
 * Regra sobre o texto do comprovante. Usa evidências fortes primeiro e marca
 * conflito quando boleto e PIX aparecem fortes ao mesmo tempo.
 */
export function analyzeReceiptText(text: string): ReceiptAnalysis {
  const boletoStrong: string[] = [];
  const boletoWeak: string[] = [];
  // O OCR costuma separar o código com pontos e espaços: a checagem usa a
  // versão sem separadores entre dígitos.
  const digitsJoined = text.replace(/(?<=\d)[.\s](?=\d)/g, '');
  // OCR de foto de celular perde ou troca 1 dígito: aceita de 44 a 48 dígitos.
  if (LINHA_DIGITAVEL.test(text) || /\d{47}/.test(digitsJoined)) boletoStrong.push('linha digitável');
  else if (/\d{44,48}/.test(digitsJoined)) boletoStrong.push('código de barras (dígitos lidos pelo OCR)');
  const term = text.match(BOLETO_TERMS)?.[0];
  if (term) boletoWeak.push(`termo "${term}"`);

  const pixStrong: string[] = [];
  const pixWeak: string[] = [];
  if (E2E_ID.test(text)) pixStrong.push('ID de transação PIX (E2E)');
  if (PIX_WORD.test(text)) pixWeak.push('menção a PIX');

  const boletoAll = [...boletoStrong, ...boletoWeak];
  const pixAll = [...pixStrong, ...pixWeak];

  // Qualquer termo de boleto junto com um ID de PIX é contraditório: vai para humano.
  if (boletoAll.length > 0 && pixStrong.length > 0) {
    return {
      kind: 'INDEFINIDO',
      confidence: 'baixa',
      evidence: [...boletoAll, ...pixAll, 'sinais de boleto e de PIX ao mesmo tempo'],
    };
  }
  if (boletoStrong.length > 0) {
    return { kind: 'BOLETO', confidence: 'alta', evidence: boletoAll };
  }
  if (pixStrong.length > 0) {
    return { kind: 'PIX', confidence: 'alta', evidence: pixAll };
  }
  if (boletoWeak.length > 0) {
    return { kind: 'BOLETO', confidence: 'media', evidence: boletoAll };
  }
  if (pixWeak.length > 0) {
    return { kind: 'PIX', confidence: 'media', evidence: pixAll };
  }
  return { kind: 'INDEFINIDO', confidence: 'baixa', evidence: [] };
}

/** Compatibilidade: só o tipo, sem evidências. */
export function classifyReceiptText(text: string): ReceiptKind {
  return analyzeReceiptText(text).kind;
}

// ─── Chamadas à NVIDIA ───────────────────────────────────────────────────────

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

/** Classifica a imagem com o modelo de visão da NVIDIA (confirmação independente). */
async function visionClassify(imageBase64: string, mimetype: string): Promise<ReceiptKind | null> {
  const apiKey = config.aiApiKey;
  if (!apiKey) return null;
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
        timeout: 40_000,
      }
    );
    const answer = (response.data?.choices?.[0]?.message?.content ?? '').toUpperCase();
    if (/\bBOLETO\b/.test(answer)) return 'BOLETO';
    if (/\bPIX\b/.test(answer)) return 'PIX';
    if (/\bINDEFINIDO\b/.test(answer)) return 'INDEFINIDO';
    return null;
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      '[ReceiptAnalysis] Modelo de visão falhou — análise segue só pelo texto'
    );
    return null;
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

// ─── Decisão final ───────────────────────────────────────────────────────────

/**
 * Combina o texto (OCR) com a visão. Sem visão disponível, mantém a análise
 * por texto e registra isso nas evidências.
 */
export function combineAnalyses(text: ReceiptAnalysis, visual: ReceiptKind | null): ReceiptAnalysis {
  if (visual === null) {
    return { ...text, evidence: [...text.evidence, 'confirmação visual indisponível'] };
  }
  if (text.kind === 'INDEFINIDO') {
    return {
      kind: visual,
      confidence: visual === 'INDEFINIDO' ? 'baixa' : 'media',
      evidence: [...text.evidence, `classificação visual: ${visual}`],
    };
  }
  if (visual === 'INDEFINIDO' || visual === text.kind) {
    return {
      ...text,
      confidence: visual === text.kind && text.confidence !== 'baixa' ? 'alta' : text.confidence,
      evidence: [...text.evidence, visual === text.kind ? 'confirmado pela visão' : 'visão não identificou o tipo'],
    };
  }
  return {
    kind: 'INDEFINIDO',
    confidence: 'baixa',
    evidence: [...text.evidence, `texto indica ${text.kind}, visão indica ${visual}`],
  };
}

/**
 * Analisa o comprovante completo. PDFs usam a primeira página. A visão sempre
 * confirma (ou contradiz) a leitura do texto.
 */
export async function analyzeReceipt(media: DownloadedMedia): Promise<ReceiptAnalysis> {
  let imageBase64: string | null = null;
  let imageMime = media.mimetype;

  if (media.mimetype === 'application/pdf') {
    imageBase64 = await pdfFirstPageToPng(media.base64);
    imageMime = 'image/png';
  } else if (media.mimetype.startsWith('image/')) {
    imageBase64 = media.base64;
  }
  if (!imageBase64) {
    return { kind: 'INDEFINIDO', confidence: 'baixa', evidence: ['arquivo não é imagem nem PDF legível'] };
  }

  // OCR e visão rodam em paralelo: o tempo total é o maior dos dois, não a soma.
  const [text, visual] = await Promise.all([
    ocrImage(imageBase64, imageMime),
    visionClassify(imageBase64, imageMime),
  ]);
  return combineAnalyses(analyzeReceiptText(text ?? ''), visual);
}

/** Compatibilidade: devolve só o tipo. */
export async function classifyReceipt(media: DownloadedMedia): Promise<ReceiptKind> {
  return (await analyzeReceipt(media)).kind;
}
