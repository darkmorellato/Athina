/**
 * @fileoverview Transcrição de notas de voz (PTT / áudio) recebidas no WhatsApp.
 *
 * Permite que clientes enviem áudios ("Oi, sou a Maria, quero pagar meu boleto")
 * e sejam atendidos normalmente pelo motor conversacional da Athina.
 * Usa endpoint OpenAI-compatible `/audio/transcriptions` (Whisper local/nuvem)
 * quando `STT_MODEL` está configurado; caso contrário, retorna `null` com
 * segurança para que o fluxo peça mensagem de texto.
 */
import config from '../../config/index.js';
import logger from '../../utils/logger.js';
import type { DownloadedMedia } from './receiptAnalysisHelper.js';

export async function transcribeAudioMedia(media: DownloadedMedia): Promise<string | null> {
  if (!media?.base64 || !media.mimetype?.startsWith('audio/')) {
    return null;
  }
  const sttModel = config.sttModel;
  if (!sttModel) {
    return null;
  }

  try {
    const rawMime = media.mimetype.split(';')[0].trim() || 'audio/ogg';
    const ext = rawMime.includes('mp4') || rawMime.includes('m4a')
      ? 'm4a'
      : rawMime.includes('mpeg') || rawMime.includes('mp3')
        ? 'mp3'
        : rawMime.includes('wav')
          ? 'wav'
          : 'ogg';

    const buffer = Buffer.from(media.base64, 'base64');
    const blob = new Blob([buffer], { type: rawMime });
    const form = new FormData();
    form.append('file', blob, `voice.${ext}`);
    form.append('model', sttModel);
    form.append('language', 'pt');

    const headers: Record<string, string> = {};
    if (config.aiApiKey) {
      headers['Authorization'] = `Bearer ${config.aiApiKey}`;
    }

    const res = await fetch(`${config.aiBaseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, '[AudioSTT] Falha ao transcrever áudio');
      return null;
    }

    const data = (await res.json()) as { text?: string };
    const text = (data?.text ?? '').trim();
    return text.length > 0 ? text : null;
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      '[AudioSTT] Erro ao transcrever nota de voz'
    );
    return null;
  }
}
