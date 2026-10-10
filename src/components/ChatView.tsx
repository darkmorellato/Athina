/**
 * @fileoverview Conversa com aparência idêntica ao WhatsApp Web (tema claro):
 * cabeçalho da conversa, separadores de data, agrupamento de bolhas e scroll.
 * UX de scroll como no WhatsApp: autoscroll SÓ quando o usuário está no fim;
 * lendo o histórico, aparece o botão "ir para o fim" com contador de novas.
 */
import { Fragment, memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bot, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import type { Message } from '../types/index.js';
import { buildTimeline } from './chat/chatLogic.js';
import { dividerFor, type UnreadMark } from '../hooks/socket/unreadLogic.js';
import { MessageBubble } from './chat/MessageBubble.js';
import { avatarPaletteFor } from './waAvatarColors.js';

interface ChatViewProps {
  /** Messages ALREADY filtered for the selected contact (see WhatsAppPanel) */
  messages: Message[];
  selectedContact: string | null;
  /** Snapshot de não-lidas da conversa aberta (divisória "N mensagens não lidas") */
  unreadMark?: UnreadMark;
  /** Foto de perfil do contato selecionado (null = sem foto) */
  avatarUrl?: string | null;
  /** Inicia um reply citando a mensagem clicada */
  onReplyMessage?: (msg: Message) => void;
  isAgentTyping: boolean;
  /** Existem mensagens mais antigas para carregar? */
  hasMore?: boolean;
  isLoadingOlder?: boolean;
  /** O histórico da conversa já terminou de carregar (1ª vez)? */
  historyLoaded?: boolean;
  onLoadOlder?: () => void;
}

export const ChatView = memo(function ChatView({
  messages,
  selectedContact,
  unreadMark,
  avatarUrl,
  onReplyMessage,
  isAgentTyping,
  hasMore,
  isLoadingOlder,
  historyLoaded,
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
  /** Divisória de não-lidas ainda não posicionada (histórico a caminho) */
  const pendingDividerScrollRef = useRef(false);
  /** Maior timestamp real já visto na conversa (filtra merges de histórico) */
  const prevLastTsRef = useRef(0);

  // Hooks incondicionais (antes de qualquer return condicional).
  // useMemo: o parser de datas/grupos NÃO roda de novo quando só o estado
  // local (digitando, avatar falhado) muda.
  const timeline = useMemo(() => buildTimeline(messages), [messages]);

  // Divisória "N mensagens não lidas": id exato (ao vivo) ou aproximação
  // pelas N últimas mensagens de cliente (baseline do servidor).
  const divider = useMemo(() => dividerFor(messages, unreadMark), [messages, unreadMark]);

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
    const dividerEl = el.querySelector<HTMLElement>('[data-unread-divider]');
    const maxTs = (list: Message[]): number =>
      list.reduce((mx, m) => Math.max(mx, m.timestamp ?? 0), 0);
    /** Posiciona a divisória de não-lidas perto do TOPO (como no WA) */
    const positionAtDivider = (): boolean => {
      if (!dividerEl) return false;
      el.scrollTop += dividerEl.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
      atBottomRef.current = false;
      setShowFab(true);
      return true;
    };
    const switched = prevContactRef.current !== selectedContact;
    // Âncora EXATA (id ao vivo) é estável; a APROXIMADA (baseline do
    // servidor) depende do histórico — e a posição sempre espera o merge
    // terminar, senão a divisória "pula" quando o histórico chega.
    const exactAnchor = Boolean(unreadMark?.firstUnreadId);
    const canPosition =
      Boolean(dividerEl) && !isLoadingOlder && (exactAnchor || Boolean(historyLoaded));
    if (switched) {
      setUnseen(0);
      if (canPosition) {
        pendingDividerScrollRef.current = false;
        positionAtDivider();
      } else if (unreadMark) {
        pendingDividerScrollRef.current = true;
        el.scrollTop = el.scrollHeight;
        atBottomRef.current = true;
        setShowFab(false);
      } else {
        pendingDividerScrollRef.current = false;
        el.scrollTop = el.scrollHeight;
        atBottomRef.current = true;
        setShowFab(false);
      }
      prevLastTsRef.current = maxTs(messages);
    } else if (pendingDividerScrollRef.current) {
      if (canPosition) {
        positionAtDivider();
        pendingDividerScrollRef.current = false;
      } else if (!isLoadingOlder && historyLoaded) {
        // Histórico terminou e não há divisória para posicionar
        pendingDividerScrollRef.current = false;
      }
    } else if (loadingOlderRef.current) {
      const delta = el.scrollHeight - savedScrollHeightRef.current;
      el.scrollTop = el.scrollTop + Math.max(delta, 0);
      loadingOlderRef.current = false;
    } else if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    } else {
      // Só conta como "novas" mensagens MAIS RECENTES que a última vista —
      // merges de HISTÓRICO (mais antigas) não inflam o contador do FAB.
      const added = messages.length - prevCountRef.current;
      if (added > 0) {
        const newOnes = messages
          .slice(prevCountRef.current)
          .filter((m) => (m.timestamp ?? Number.MAX_SAFE_INTEGER) >= prevLastTsRef.current)
          .length;
        if (newOnes > 0) {
          setUnseen((u) => u + newOnes);
          setShowFab(true);
        }
      }
    }
    prevCountRef.current = messages.length;
    prevLastTsRef.current = Math.max(prevLastTsRef.current, maxTs(messages));
    prevContactRef.current = selectedContact;
  }, [messages, selectedContact, unreadMark, isLoadingOlder, historyLoaded]);

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
            <Fragment key={item.msg.id}>
              {/* Divisória "N mensagens não lidas" (pílula verde do WhatsApp) */}
              {divider && item.msg.id === divider.id && (
                <div className="wa-date-wrap" data-unread-divider>
                  <span className="wa-unread-divider">{divider.label}</span>
                </div>
              )}
              <MessageBubble
                msg={item.msg}
                firstInGroup={item.firstInGroup}
                lastInGroup={item.lastInGroup}
                avatarUrl={avatarUrl}
                onReply={onReplyMessage}
              />
            </Fragment>
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
