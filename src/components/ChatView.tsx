/**
 * @fileoverview Conversa com aparência idêntica ao WhatsApp Web (tema claro):
 * cabeçalho da conversa, separadores de data, agrupamento de bolhas e scroll.
 */
import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Bot, ChevronUp, Loader2 } from 'lucide-react';
import type { Message } from '../types/index.js';
import { buildTimeline } from './chat/chatLogic.js';
import { MessageBubble } from './chat/MessageBubble.js';

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

  const handleLoadOlder = useCallback(() => {
    const el = scrollRef.current;
    if (!el || isLoadingOlder) return;
    loadingOlderRef.current = true;
    savedScrollHeightRef.current = el.scrollHeight;
    onLoadOlder?.();
  }, [isLoadingOlder, onLoadOlder]);

  // Scroll: preserva a posição ao carregar mensagens anteriores;
  // caso contrário, mantém a conversa no final (mensagens novas / troca de contato).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const switched = prevContactRef.current !== selectedContact;
    if (loadingOlderRef.current && !switched) {
      const delta = el.scrollHeight - savedScrollHeightRef.current;
      el.scrollTop = el.scrollTop + Math.max(delta, 0);
      loadingOlderRef.current = false;
    } else {
      el.scrollTop = el.scrollHeight;
    }
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
  const timeline = buildTimeline(messages);
  const showAvatar = Boolean(avatarUrl) && failedAvatar !== avatarUrl;

  return (
    <div className="wa-chat-bg flex-1 flex flex-col relative overflow-hidden">
      {/* Cabeçalho da conversa (tray + avatar + nome, como no WhatsApp) */}
      <header className="wa-chat-header">
        <div className="wa-chat-avatar">
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
          <span className="wa-chat-sub">cliente ativo</span>
        </div>
      </header>

      {/* Messages — select-text reativa a seleção desativada na raiz (select-none)
          para permitir copiar mensagens (Ctrl+C / Cmd+C), como no WhatsApp */}
      <div ref={scrollRef} className="wa-scroll select-text">
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

        {isAgentTyping && (
          <div className="wa-row wa-row-out wa-row-first">
            <div
              className="wa-bubble wa-bubble-out wa-bubble-tail-out wa-typing"
              aria-label="Athina está digitando"
            >
              <span className="wa-tail wa-tail-out" aria-hidden />
              <span className="wa-typing-dot" />
              <span className="wa-typing-dot" style={{ animationDelay: '.15s' }} />
              <span className="wa-typing-dot" style={{ animationDelay: '.3s' }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
