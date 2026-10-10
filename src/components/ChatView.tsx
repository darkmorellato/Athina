/**
 * @fileoverview Conversa com aparência idêntica ao WhatsApp Web (tema claro):
 * cabeçalho da conversa, separadores de data, agrupamento de bolhas e scroll.
 * UX de scroll como no WhatsApp: autoscroll SÓ quando o usuário está no fim;
 * lendo o histórico, aparece o botão "ir para o fim" com contador de novas.
 */
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bot, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import type { Message } from '../types/index.js';
import { buildTimeline } from './chat/chatLogic.js';
import { MessageBubble } from './chat/MessageBubble.js';
import { avatarPaletteFor } from './waAvatarColors.js';

interface ChatViewProps {
  /** Messages ALREADY filtered for the selected contact (see WhatsAppPanel) */
  messages: Message[];
  selectedContact: string | null;
  /** Foto de perfil do contato selecionado (null = sem foto) */
  avatarUrl?: string | null;
  /** Inicia um reply citando a mensagem clicada */
  onReplyMessage?: (msg: Message) => void;
  isAgentTyping: boolean;
  /** Existem mensagens mais antigas para carregar? */
  hasMore?: boolean;
  isLoadingOlder?: boolean;
  onLoadOlder?: () => void;
}

export const ChatView = memo(function ChatView({
  messages,
  selectedContact,
  avatarUrl,
  onReplyMessage,
  isAgentTyping,
  hasMore,
  isLoadingOlder,
  onLoadOlder,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const loadingOlderRef = useRef(false);
  const savedScrollHeightRef = useRef(0);
  const prevContactRef = useRef<string | null>(null);
  /** O usuário está no fim da conversa? (default: sim) */
  const atBottomRef = useRef(true);
  const [showFab, setShowFab] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const prevCountRef = useRef(0);

  // Hooks incondicionais (antes de qualquer return condicional).
  // useMemo: o parser de datas/grupos NÃO roda de novo quando só o estado
  // local (digitando, avatar falhado) muda.
  const timeline = useMemo(() => buildTimeline(messages), [messages]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    atBottomRef.current = atBottom;
    setShowFab(!atBottom);
    if (atBottom) setUnseen(0);
  }, []);

  const scrollToEnd = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setShowFab(false);
    setUnseen(0);
  }, []);

  const handleLoadOlder = useCallback(() => {
    const el = scrollRef.current;
    if (!el || isLoadingOlder) return;
    loadingOlderRef.current = true;
    savedScrollHeightRef.current = el.scrollHeight;
    onLoadOlder?.();
  }, [isLoadingOlder, onLoadOlder]);

  // Scroll: preserva a posição ao carregar mensagens anteriores; autoscroll SÓ
  // quando o usuário está no fim (ou trocou de conversa) — como no WhatsApp.
  // Se ele está lendo o histórico, as mensagens novas viram o contador do
  // botão "ir para o fim" em vez de arrancar a tela do lugar.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const switched = prevContactRef.current !== selectedContact;
    if (switched) {
      el.scrollTop = el.scrollHeight;
      atBottomRef.current = true;
      setUnseen(0);
      setShowFab(false);
    } else if (loadingOlderRef.current) {
      const delta = el.scrollHeight - savedScrollHeightRef.current;
      el.scrollTop = el.scrollTop + Math.max(delta, 0);
      loadingOlderRef.current = false;
    } else if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    } else {
      const added = messages.length - prevCountRef.current;
      if (added > 0) {
        setUnseen((u) => u + added);
        setShowFab(true);
      }
    }
    prevCountRef.current = messages.length;
    prevContactRef.current = selectedContact;
  }, [messages, selectedContact]);

  if (!selectedContact) {
    return (
      <div className="wa-chat-bg flex-1 flex flex-col items-center justify-center
        text-[#8696a0] text-sm gap-3 px-8 text-center">
        <Bot size={56} className="opacity-50" />
        <span>Selecione uma conversa na barra lateral</span>
      </div>
    );
  }

  // Nome amigável: usa o nome resolvido das mensagens quando disponível
  const contactName = messages[0]?.fromName || selectedContact.split('@')[0];
  const showAvatar = Boolean(avatarUrl) && failedAvatar !== avatarUrl;
  const avatarPalette = avatarPaletteFor(selectedContact);

  return (
    <div className="wa-chat-bg flex-1 flex flex-col relative overflow-hidden">
      {/* Cabeçalho da conversa (tray + avatar + nome, como no WhatsApp) */}
      <header className="wa-chat-header">
        <div
          className="wa-chat-avatar"
          style={
            showAvatar
              ? undefined
              : { backgroundColor: avatarPalette.bg, color: avatarPalette.fg }
          }
        >
          {showAvatar ? (
            <img
              src={avatarUrl as string}
              alt=""
              className="w-full h-full object-cover"
              onError={() => setFailedAvatar(avatarUrl ?? null)}
            />
          ) : (
            <span>{contactName[0]}</span>
          )}
        </div>
        <div className="flex flex-col min-w-0">
          <h3 className="wa-chat-name truncate">{contactName}</h3>
          <span className="wa-chat-sub">{isAgentTyping ? 'digitando…' : 'cliente ativo'}</span>
        </div>
      </header>

      {/* Messages — select-text reativa a seleção desativada na raiz (select-none)
          para permitir copiar mensagens (Ctrl+C / Cmd+C), como no WhatsApp */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-label="Mensagens da conversa"
        className="wa-scroll select-text"
      >
        {hasMore && (
          <button
            onClick={handleLoadOlder}
            disabled={isLoadingOlder}
            className="wa-load-older"
          >
            {isLoadingOlder ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <ChevronUp size={13} />
            )}
            {isLoadingOlder ? 'Carregando...' : 'Mensagens anteriores'}
          </button>
        )}

        {timeline.map((item) =>
          item.kind === 'date' ? (
            <div key={item.key} className="wa-date-wrap">
              <span className="wa-date">{item.label}</span>
            </div>
          ) : (
            <MessageBubble
              key={item.msg.id}
              msg={item.msg}
              firstInGroup={item.firstInGroup}
              lastInGroup={item.lastInGroup}
              avatarUrl={avatarUrl}
              onReply={onReplyMessage}
            />
          )
        )}

        {/* "digitando…" como bolha RECEBIDA (branca) — o indicador verde de
            saída destoava do WhatsApp, que mostra o status no cabeçalho. */}
        {isAgentTyping && (
          <div className="wa-row wa-row-in wa-row-first">
            <div
              className="wa-bubble wa-bubble-in wa-bubble-tail-in wa-typing"
              aria-label="Athina está digitando"
            >
              <span className="wa-tail wa-tail-in" aria-hidden />
              <span className="wa-typing-dot" />
              <span className="wa-typing-dot" style={{ animationDelay: '.15s' }} />
              <span className="wa-typing-dot" style={{ animationDelay: '.3s' }} />
            </div>
          </div>
        )}
      </div>

      {/* Botão "ir para o fim" com contador de novas (padrão do WhatsApp) */}
      {showFab && (
        <button
          type="button"
          className="wa-fab"
          onClick={scrollToEnd}
          title="Ir para o fim"
          aria-label="Ir para o fim"
        >
          <ChevronDown size={22} />
          {unseen > 0 && (
            <span className="wa-fab-badge">{unseen > 99 ? '99+' : unseen}</span>
          )}
        </button>
      )}
    </div>
  );
});
