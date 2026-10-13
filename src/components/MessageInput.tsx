/** @fileoverview Composer (barra de digitação) no estilo WhatsApp Web.
 *
 * Suporta: texto, COLAGEM de imagem (Ctrl+V/Cmd+V), arrastar-e-soltar e o
 * botão de anexo (+). A legenda da imagem é o texto digitado no campo.
 * Composer fiel: botão de enviar DENTRO da pílula (como no WA), emoji
 * inserido na posição do cursor, picker fecha com ESC/clique fora.
 */
import { useEffect, useRef, useState } from 'react';
import { FileText, Plus, Smile, X } from 'lucide-react';
import type { ReplyTarget } from '../types/index.js';
import { SENDABLE_MIME_TYPES, type SendFileReplyPayload } from '@shared/contracts.js';
import { SendIcon } from './chat/icons.js';

/** MIME permitido no envio (fonte única: shared/contracts.ts) */
type SendableMime = SendFileReplyPayload['mimetype'];

interface PendingFile {
  base64: string; // sem o prefixo data:
  mimetype: SendableMime;
  filename: string;
  previewUrl: string | null; // data URL só para imagens
  size: number;
}

interface MessageInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  /** Envia imagem (colada/arrastada/escolhida) como mensagem com legenda opcional */
  onSendFile?: (base64: string, mimetype: SendableMime, filename: string, caption: string) => void;
  /** Mensagem que está sendo respondida (reply/quote) */
  replyTo?: ReplyTarget | null;
  /** Cancela o reply em andamento */
  onCancelReply?: () => void;
}

const MAX_FILE_BYTES = 15 * 1024 * 1024; // ~15MB (WhatsApp limita ~16MB)
const isSendableType = (t: string): t is SendableMime =>
  (SENDABLE_MIME_TYPES as readonly string[]).includes(t);
const ACCEPT_ATTR = SENDABLE_MIME_TYPES.join(',');
const EMOJIS = [
  '😀', '😂', '🥰', '😎', '🤔', '👍', '🙏', '❤️',
  '🔥', '🎉', '✅', '😅', '😍', '😢', '🤝', '💚',
];

export function MessageInput({
  value,
  onChange,
  onSend,
  onSendFile,
  replyTo,
  onCancelReply,
}: MessageInputProps) {
  const [pending, setPending] = useState<PendingFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const emojiPanelRef = useRef<HTMLDivElement>(null);

  // ESC fecha o picker; clique fora também (padrão do WhatsApp)
  useEffect(() => {
    if (!emojiOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setEmojiOpen(false);
    };
    const onDown = (e: MouseEvent): void => {
      if (emojiPanelRef.current && !emojiPanelRef.current.contains(e.target as Node)) {
        setEmojiOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [emojiOpen]);

  const loadFile = (file: File | null | undefined): void => {
    setError(null);
    if (!file) return;
    if (!isSendableType(file.type)) {
      setError('Tipo de arquivo não suportado (imagem, vídeo, PDF, Word, Excel ou texto).');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError(`Arquivo muito grande (máx. ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)}MB).`);
      return;
    }
    const mime = file.type; // já estreitado pelo type guard (SendableMime)
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      const [, base64] = dataUrl.split(',');
      const previewUrl = mime.startsWith('image/') ? dataUrl : null;
      setPending({ base64, mimetype: mime, filename: file.name || 'arquivo', previewUrl, size: file.size });
    };
    reader.onerror = () => setError('Não consegui ler o arquivo.');
    reader.readAsDataURL(file);
  };

  // Colar imagem (Ctrl+V) — pega o primeiro arquivo de imagem do clipboard
  const handlePaste = (e: React.ClipboardEvent): void => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        loadFile(item.getAsFile());
        return;
      }
    }
  };

  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    setDragOver(false);
    loadFile(e.dataTransfer?.files?.[0]);
  };

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>): void => {
    loadFile(e.target.files?.[0]);
    e.target.value = '';
  };

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (pending && onSendFile) {
      onSendFile(pending.base64, pending.mimetype, pending.filename, value.trim());
      setPending(null);
      onChange(''); // legenda enviada junto — limpa o campo
      return;
    }
    onSend();
  };

  /** Insere o emoji NA POSIÇÃO DO CURSOR (antes ia sempre para o fim). */
  const insertEmoji = (emoji: string): void => {
    const input = inputRef.current;
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + emoji + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      input?.focus();
      const pos = start + emoji.length;
      try {
        input?.setSelectionRange(pos, pos);
      } catch {
        /* input sem suporte a seleção — ignora */
      }
    });
  };

  const canSend = Boolean(pending) || value.trim().length > 0;

  return (
    <form
      onSubmit={handleSubmit}
      onPaste={handlePaste}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      className={`wa-composer${dragOver ? ' wa-composer-drop' : ''}`}
    >
      {error && <span className="text-[12px] text-red-600 font-medium px-1">{error}</span>}

      {replyTo && (
        <div className="wa-composer-quote">
          <span className="wa-composer-quote-bar" aria-hidden />
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-[12.5px] font-semibold text-[#1daa61] truncate">
              Respondendo {replyTo.fromName}
            </span>
            <span className="text-[13px] text-black/60 truncate">{replyTo.text}</span>
          </div>
          <button
            type="button"
            onClick={onCancelReply}
            className="wa-icon-btn wa-icon-btn-sm"
            title="Cancelar resposta"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {pending && (
        <div className="wa-composer-chip">
          {pending.previewUrl ? (
            <img
              src={pending.previewUrl}
              alt="Pré-visualização"
              className="w-12 h-12 rounded-lg object-cover border border-black/5 shrink-0"
            />
          ) : (
            <div className="w-12 h-12 rounded-lg bg-black/5 flex items-center justify-center shrink-0">
              <FileText size={20} className="text-black/50" />
            </div>
          )}
          <div className="flex flex-col min-w-0">
            <span className="text-[12.5px] font-semibold text-black/80 truncate">
              {pending.filename}
            </span>
            <span className="text-[11px] text-black/45">
              {(pending.size / 1024).toFixed(0)} KB · a legenda é o texto do campo
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              setPending(null);
              setError(null);
            }}
            className="wa-icon-btn wa-icon-btn-sm"
            title="Remover arquivo"
          >
            <X size={16} />
          </button>
        </div>
      )}

      <div className="wa-composer-row">
        <button
          type="button"
          className="wa-icon-btn"
          title="Anexar imagem"
          onClick={() => fileRef.current?.click()}
        >
          <Plus size={24} />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT_ATTR}
          className="hidden"
          onChange={handleFilePick}
        />

        {/* Pílula com input + emoji + ENVIAR dentro (como no WhatsApp Web) */}
        <div className="wa-composer-pill">
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={pending ? 'Adicione uma legenda (opcional)' : 'Digite uma mensagem'}
            className="wa-composer-input"
            aria-label="Digite uma mensagem"
          />
          <button
            type="button"
            className="wa-icon-btn wa-icon-btn-sm"
            title="Emojis"
            aria-label="Emojis"
            onClick={() => setEmojiOpen((v) => !v)}
          >
            <Smile size={22} />
          </button>
          <button
            type="submit"
            className="wa-icon-btn wa-icon-btn-sm wa-send-btn"
            disabled={!canSend}
            title={pending ? 'Enviar arquivo' : 'Enviar mensagem'}
            aria-label={pending ? 'Enviar arquivo' : 'Enviar mensagem'}
          >
            <SendIcon width={20} height={20} />
          </button>
        </div>

        {emojiOpen && (
          <div className="wa-emoji-panel" ref={emojiPanelRef}>
            {EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="wa-emoji-btn"
                onMouseDown={(ev) => ev.preventDefault()}
                onClick={() => insertEmoji(emoji)}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>
    </form>
  );
}
