/**
 * @fileoverview Bolha de mensagem com aparência do WhatsApp Web (tema claro):
 * cauda SVG, agrupamento, citação, mídia (imagem / voz / arquivo),
 * meta (hora + ticks ✓✓) e OCR Shield.
 */
import { memo } from 'react';
import type { ReactNode } from 'react';
import { Reply } from 'lucide-react';
import type { Message } from '../../types/index.js';
import { CheckIcon, ClockIcon, DoubleCheckIcon } from './icons.js';
import { VoiceNotePlayer } from './VoiceNotePlayer.js';

/**
 * Formatação de negrito como no WhatsApp: *texto* (e **texto**, antes da
 * sanitização) vira <strong>. Pares não encontrados ficam intactos.
 */
function renderBold(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return <strong key={i}>{part.slice(1, -1)}</strong>;
    }
    return part;
  });
}

interface MessageBubbleProps {
  msg: Message;
  /** Primeira bolha do grupo (leva a cauda) */
  firstInGroup: boolean;
  /** Última bolha do grupo (leva hora + ticks) */
  lastInGroup: boolean;
  /** Foto do contato (usada no player de voz recebida) */
  avatarUrl?: string | null;
  onReply?: (msg: Message) => void;
}

export const MessageBubble = memo(function MessageBubble({
  msg,
  firstInGroup,
  lastInGroup,
  avatarUrl,
  onReply,
}: MessageBubbleProps) {
  const isCustomer = msg.sender === 'customer';
  const canReply = Boolean(onReply && msg.serializedId);
  const hasText = Boolean(msg.text);
  const hasMedia = Boolean(msg.mediaData && msg.mediaMimeType);
  const mediaUrl = hasMedia ? `data:${msg.mediaMimeType};base64,${msg.mediaData}` : '';
  const mediaKind: 'image' | 'audio' | 'file' | null = !hasMedia
    ? null
    : msg.mediaMimeType!.startsWith('image/')
      ? 'image'
      : msg.mediaMimeType!.startsWith('audio/')
        ? 'audio'
        : 'file';

  const hidden = lastInGroup ? '' : ' wa-meta-hidden';
  // Recibo como no WhatsApp: 🕓 pendente → ✓ enviado → ✓✓ entregue (cinza)
  // → ✓✓ LIDO (azul). Sem ack (histórico antigo), mantém ✓✓ cinza.
  const ack = typeof msg.ack === 'number' ? msg.ack : undefined;
  const tick = !isCustomer ? (
    ack === 0 ? (
      <ClockIcon className="wa-tick" />
    ) : ack === 1 ? (
      <CheckIcon className="wa-tick" />
    ) : (
      <DoubleCheckIcon className={`wa-tick${ack !== undefined && ack >= 3 ? ' wa-tick-read' : ''}`} />
    )
  ) : null;

  const metaInline = (
    <span className={`wa-meta${hidden}`} aria-hidden={!lastInGroup}>
      <span>{msg.time}</span>
      {tick}
    </span>
  );
  const metaRow = (
    <div className={`wa-meta-row${hidden}`} aria-hidden={!lastInGroup}>
      <span>{msg.time}</span>
      {tick}
    </div>
  );
  const metaOverlay = (
    <span className={`wa-img-meta${hidden}`} aria-hidden={!lastInGroup}>
      <span>{msg.time}</span>
      {tick}
    </span>
  );

  const openImage = (): void => {
    const win = window.open();
    if (win) {
      win.document.write(
        `<img src="${mediaUrl}" style="max-width:100%; max-height:100vh; display:block; margin:auto; border-radius:8px;" />`
      );
    }
  };

  return (
    <div className={`wa-row ${isCustomer ? 'wa-row-in' : 'wa-row-out'}${firstInGroup ? ' wa-row-first' : ''}`}>
      <div
        className={`wa-bubble ${isCustomer ? 'wa-bubble-in' : 'wa-bubble-out'}${
          firstInGroup ? (isCustomer ? ' wa-bubble-tail-in' : ' wa-bubble-tail-out') : ''
        }`}
      >
        {firstInGroup && (
          <span className={`wa-tail ${isCustomer ? 'wa-tail-in' : 'wa-tail-out'}`} aria-hidden />
        )}

        {canReply && (
          <button
            type="button"
            title="Responder esta mensagem"
            onClick={() => onReply?.(msg)}
            className={`wa-reply-btn ${isCustomer ? 'wa-reply-btn-in' : 'wa-reply-btn-out'}`}
          >
            <Reply size={14} />
          </button>
        )}

        {msg.quoted && (
          <div className="wa-quote">
            <span className="wa-quote-author">{msg.quoted.fromMe ? 'Você' : 'Cliente'}</span>
            <p className="wa-quote-text">{msg.quoted.body || '📎 Mídia'}</p>
          </div>
        )}

        {mediaKind === 'image' && (
          <div className="wa-media">
            <div className="wa-media-wrap">
              <img src={mediaUrl} alt="Imagem recebida" className="wa-img" onClick={openImage} />
              {!hasText && <span className="wa-media-scrim" aria-hidden />}
              {!hasText && metaOverlay}
            </div>
            {hasText && (
              <div className="wa-caption">
                {renderBold(msg.text)}
                {metaInline}
              </div>
            )}
          </div>
        )}

        {mediaKind === 'audio' && (
          <div className="wa-audio">
            <VoiceNotePlayer src={mediaUrl} isOut={!isCustomer} avatarUrl={isCustomer ? avatarUrl : null} />
            {metaRow}
          </div>
        )}

        {mediaKind === 'file' && (
          <div className="wa-doc-wrap">
            {hasText && <div className="wa-text">{renderBold(msg.text)}</div>}
            <a
              className="wa-doc"
              href={mediaUrl}
              download={`arquivo.${(msg.mediaMimeType || 'bin').split('/')[1] || 'bin'}`}
            >
              📎 Baixar arquivo ({msg.mediaMimeType})
            </a>
            {metaRow}
          </div>
        )}

        {!hasMedia && hasText && (
          <div className="wa-text">
            {renderBold(msg.text)}
            {metaInline}
          </div>
        )}

        {msg.ocrStatus && <OCRBadge msg={msg} />}
      </div>
    </div>
  );
});

function OCRBadge({ msg }: { msg: Message }) {
  const colors = {
    safe: { bg: 'bg-emerald-50 border-emerald-200 text-emerald-800', label: msg.ocrLabel },
    suspicious: { bg: 'bg-amber-50 border-amber-200 text-amber-800', label: msg.ocrLabel },
    fraud: { bg: 'bg-red-50 border-red-200 text-red-800', label: msg.ocrLabel },
  };

  const style = colors[msg.ocrStatus as keyof typeof colors] ?? colors.suspicious;

  return (
    <div className={`mx-1.5 mb-1.5 mt-1 p-2.5 rounded-xl border text-[11px] leading-normal
      flex flex-col gap-1 shadow-inner ${style.bg}`}>
      <div className="flex items-center justify-between font-bold">
        <span>🛡️ OCR Shield Guard</span>
        <span className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wide
          bg-white/70 shadow-xs font-extrabold">
          {style.label}
        </span>
      </div>
      <p className="opacity-90">{msg.ocrReason}</p>
      {msg.ocrValue && (
        <div className="mt-1.5 flex items-center justify-between
          border-t border-dashed border-gray-300 pt-1.5 text-[10px] font-medium">
          <span>💰 Valor Lido: <b>{msg.ocrValue}</b></span>
          {msg.ocrDate && <span>📅 Data: <b>{msg.ocrDate}</b></span>}
        </div>
      )}
    </div>
  );
}
