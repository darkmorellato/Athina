/** @fileoverview Composer (barra de digitação) no estilo WhatsApp Web.
 *
 * Suporta: texto, COLAGEM de imagem (Ctrl+V/Cmd+V), arrastar-e-soltar e o
 * botão de anexo (+). A legenda da imagem é o texto digitado no campo.
 */
import { useRef, useState } from 'react';
import { Plus, Smile, X } from 'lucide-react';
import type { ReplyTarget } from '../types/index.js';
import { SendIcon } from './chat/icons.js';

interface PendingImage {
  base64: string; // sem o prefixo data:
  mimetype: string;
  previewUrl: string; // data URL para o <img>
  size: number;
}

interface MessageInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  /** Envia imagem (colada/arrastada/escolhida) como mensagem com legenda opcional */
  onSendImage?: (base64: string, mimetype: string, caption: string) => void;
  /** Mensagem que está sendo respondida (reply/quote) */
  replyTo?: ReplyTarget | null;
  /** Cancela o reply em andamento */
  onCancelReply?: () => void;
}

const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // ~15MB (WhatsApp limita ~16MB)
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const EMOJIS = [
  '😀', '😂', '🥰', '😎', '🤔', '👍', '🙏', '❤️',
  '🔥', '🎉', '✅', '😅', '😍', '😢', '🤝', '💚',
];

export function MessageInput({
  value,
  onChange,
  onSend,
  onSendImage,
  replyTo,
  onCancelReply,
}: MessageInputProps) {
  const [pending, setPending] = useState<PendingImage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadFile = (file: File | null | undefined): void => {
    setError(null);
    if (!file) return;
    if (!ALLOWED_TYPES.includes(file.type)) {
      setError('Só imagens (JPG, PNG, WEBP ou GIF).');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError(`Imagem muito grande (máx. ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB).`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      const [meta, base64] = dataUrl.split(',');
      const mime = meta.replace('data:', '').replace(';base64', '');
      setPending({ base64, mimetype: mime, previewUrl: dataUrl, size: file.size });
    };
    reader.onerror = () => setError('Não consegui ler a imagem.');
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
    if (pending && onSendImage) {
      onSendImage(pending.base64, pending.mimetype, value.trim());
      setPending(null);
      onChange(''); // legenda enviada junto — limpa o campo
      return;
    }
    onSend();
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
            <span className="text-[12.5px] font-semibold text-[#24d366] truncate">
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
          <img
            src={pending.previewUrl}
            alt="Pré-visualização"
            className="w-12 h-12 rounded-lg object-cover border border-black/5 shrink-0"
          />
          <div className="flex flex-col min-w-0">
            <span className="text-[12.5px] font-semibold text-black/80 truncate">
              Imagem pronta para enviar
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
            title="Remover imagem"
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
          accept="image/jpeg,image/png,image/webp,image/gif"
          className="hidden"
          onChange={handleFilePick}
        />

        <div className="wa-composer-pill">
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={pending ? 'Adicione uma legenda (opcional)' : 'Digite uma mensagem'}
            className="wa-composer-input"
          />
          <button
            type="button"
            className="wa-icon-btn wa-icon-btn-sm"
            title="Emojis"
            onClick={() => setEmojiOpen((v) => !v)}
          >
            <Smile size={22} />
          </button>
        </div>

        <button
          type="submit"
          className="wa-icon-btn wa-send-btn"
          disabled={!canSend}
          title={pending ? 'Enviar imagem' : 'Enviar mensagem'}
        >
          <SendIcon width={22} height={22} />
        </button>

        {emojiOpen && (
          <div className="wa-emoji-panel">
            {EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="wa-emoji-btn"
                onMouseDown={(ev) => ev.preventDefault()}
                onClick={() => {
                  onChange(value + emoji);
                  inputRef.current?.focus();
                }}
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
