import type { Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@shared/contracts.js';
import type { Message, WAMessage } from '../../types/index.js';
import type { SocketEventHandlers } from './socketEvents.js';
import {
  createMessageId,
  formatTime,
  isHostileMessage,
  playAlertSound,
  buildAIResponseIndex,
  nowTs,
  cancelHuman,
  waOutbound,
} from './socketHelpers.js';
import { handleStageConfirmation, handleStageCollecting } from './stageHandlers.js';
import { handlePaymobiResult, handlePaymobiError } from './paymobiHandlers.js';

/**
 * Chat states are now managed server-side via Redis.
 * This module sends/receives state updates to/from the backend.
 */

/** Track which message IDs have been processed (circular buffer) */
const MAX_PROCESSED_IDS = 5000;
const processedMessageIds = new Set<string>();
const processedIdOrder: string[] = [];

/**
 * Ouvintes de 'chat-state-loaded' por contato. Sem isto, cada mensagem nova
 * registrava outro ouvinte e os anteriores ainda dentro da janela de 2s
 * reprocessavam a mesma resposta — gerando mensagens duplicadas (ex.:
 * confirmação aparecendo duas vezes).
 */
const stateWaiters = new Map<string, (data: { contactId: string; state: any }) => void>();

function trackProcessedId(id: string): void {
  if (processedMessageIds.has(id)) return;
  processedMessageIds.add(id);
  processedIdOrder.push(id);
  while (processedIdOrder.length > MAX_PROCESSED_IDS) {
    const oldest = processedIdOrder.shift()!;
    processedMessageIds.delete(oldest);
  }
}

export function createSocketHandlers(
  socket: Socket<ServerToClientEvents, ClientToServerEvents>,
  handlers: SocketEventHandlers
) {
  const {
    addLog,
    setMessages,
    setIsAgentTyping,
    quickRepliesRef,
    isAgentActiveRef,
    serverAutoReplyRef,
    messagesRef,
  } = handlers;

  const handleMessage = (msg: WAMessage): void => {
    const contactId = msg.from;
    const contactName = msg.name || contactId.split('@')[0];

    // Deduplication
    if (msg.id) {
      if (processedMessageIds.has(msg.id) || messagesRef.current.some((m) => m.id === msg.id)) {
        return;
      }
      trackProcessedId(msg.id);
    }

    const newMsg: Message = {
      id: msg.id || createMessageId(),
      text: msg.body,
      sender: msg.sender || 'customer',
      fromId: contactId,
      fromName: contactName,
      // Hora do RELÓGIO DO WHATSAPP (timestamp), não do momento do handler —
      // mensagens atrasadas/reprocessadas mostravam hora errada.
      time:
        typeof msg.timestamp === 'number' && msg.timestamp > 0
          ? new Date(msg.timestamp * 1000).toLocaleTimeString('pt-BR', {
              hour: '2-digit',
              minute: '2-digit',
            })
          : formatTime(),
      // O painel ordena por timestamp — sem ele a mensagem era classificada
      // como "a mais antiga" (0) e ia para o TOPO do chat, fora da vista
      // (o usuário só via tudo ao trocar de conversa e voltar, quando o
      // histórico é recarregado com timestamp correto).
      timestamp:
        typeof msg.timestamp === 'number' && msg.timestamp > 0
          ? msg.timestamp
          : Math.floor(Date.now() / 1000),
      mediaData: msg.mediaData,
      mediaMimeType: msg.mediaMimeType,
      serializedId: msg.serializedId,
      quoted: msg.quoted,
      // Recibo inicial (1 = enviado); atualizado depois por 'message-ack'.
      ...(typeof msg.ack === 'number' ? { ack: msg.ack } : {}),
    };

    setMessages((prev) => {
      let next = prev;
      // Mensagens dos fluxos do painel são renderizadas localmente (id sintético
      // 'ai-…') E enviadas ao WhatsApp. Quando a mensagem real chega, remove o
      // gêmeo otimista (mesmo contato + mesmo texto) para não duplicar.
      if (newMsg.sender === 'agent') {
        const isOptimisticTwin = (m: Message) =>
          m.id.startsWith('ai-') && m.fromId === newMsg.fromId && m.text === newMsg.text;
        if (prev.some(isOptimisticTwin)) {
          next = prev.filter((m) => !isOptimisticTwin(m));
        }
      }
      return [...next, newMsg];
    });

    // Ignore agent's own messages for processing
    if (newMsg.sender === 'agent') return;

    // Hostile message detection
    if (isHostileMessage(msg.body)) {
      addLog(`⚠️ [ALERTA] Mensagem hostil de ${contactName}!`, 'error');
      playAlertSound();
    }

    // Process with AI agent if active (and the server-side autonomous agent is OFF)
    if (isAgentActiveRef.current && !serverAutoReplyRef.current) {
      const bodyClean = msg.body.trim();
      const bodyLower = bodyClean.toLowerCase();

      // Mensagem nova do cliente → cancela respostas ainda agendadas do
      // contato (nada chega depois de um reinício pedido pelo cliente).
      cancelHuman(contactId);

      const stageCtx = {
        socket,
        contactId,
        contactName,
        bodyClean,
        bodyLower,
        messagesRef,
        setMessages,
        quickRepliesRef,
        addLog,
        setIsAgentTyping,
      };

      // Request current state from backend
      socket.emit('get-chat-state', { contactId });

      // Listen for state response (one-time)
      const handleStateLoaded = (data: { contactId: string; state: any }) => {
        if (data.contactId !== contactId) return;
        socket.off('chat-state-loaded', handleStateLoaded);
        if (stateWaiters.get(contactId) === handleStateLoaded) {
          stateWaiters.delete(contactId);
        }

        const state = data.state || { stage: 'COLLECTING' };

        if (state.stage === 'WAITING_CONFIRMATION') {
          // Pass pending data from server state
          handleStageConfirmation({
            ...stageCtx,
            bodyLower,
            chatStates: { [contactId]: state },
            saveChatStates: (updated: Record<string, any>) => {
              const newState = updated[contactId];
              if (newState) {
                if (newState.stage === 'WAITING_CONFIRMATION') {
                  socket.emit('update-chat-state', { contactId, state: newState });
                } else {
                  socket.emit('reset-chat-state', { contactId });
                }
              }
            },
            quickRepliesRef: quickRepliesRef as React.MutableRefObject<string[]>,
          });
        } else {
          // Coleta parcial (nome/CPF) vem do ESTADO DO SERVIDOR por contato
          // — nunca do histórico de mensagens (misturava dados entre chats).
          handleStageCollecting({ ...stageCtx, collect: state.collect }, msg as WAMessage);
        }
      };

      // Substitui qualquer ouvinte pendente do MESMO contato antes de
      // registrar (garante processamento único por mensagem).
      const previousWaiter = stateWaiters.get(contactId);
      if (previousWaiter) socket.off('chat-state-loaded', previousWaiter);
      stateWaiters.set(contactId, handleStateLoaded);
      socket.on('chat-state-loaded', handleStateLoaded);

      // Timeout fallback — if backend doesn't respond in 2s, default to COLLECTING
      setTimeout(() => {
        socket.off('chat-state-loaded', handleStateLoaded);
        if (stateWaiters.get(contactId) === handleStateLoaded) {
          stateWaiters.delete(contactId);
        }
      }, 2000);
    }
  };

  const handleAIResponse = (data: { text: string; contactId: string; isSentDirectly?: boolean }): void => {
    setIsAgentTyping(false);
    const replyIndex = buildAIResponseIndex(data.text);
    const textToSend = waOutbound(replyIndex >= 0 ? quickRepliesRef.current[replyIndex] : data.text);
    const agentMsg: Message = {
      id: `ai-${Date.now()}`,
      text: textToSend,
      sender: 'agent',
      fromId: data.contactId,
      time: formatTime(),
      timestamp: nowTs(),
    };
    setMessages((prev) => [...prev, agentMsg]);

    // Send reply to WhatsApp
    socket.emit('send-reply', { to: data.contactId, text: textToSend });
    addLog(`Resposta enviada para ${data.contactId.split('@')[0]}`, 'success');
  };

  const onPaymobiResult = (data: { result: any; contactId?: string }): void => {
    const paymobiCtx = {
      socket,
      setMessages,
      addLog,
      setIsAgentTyping,
    };
    handlePaymobiResult(paymobiCtx, data);
  };

  const onPaymobiError = (data: { message: string; contactId?: string }): void => {
    const paymobiCtx = {
      setMessages,
      socket,
      addLog,
      setIsAgentTyping,
    };
    handlePaymobiError(paymobiCtx, data);
  };

  /** Atualiza o recibo (ticks) de uma mensagem pelo id serializado do WhatsApp. */
  const handleMessageAck = (data: { id: string; ack: number }): void => {
    if (!data?.id) return;
    setMessages((prev) => {
      let changed = false;
      const next = prev.map((m) => {
        const isTarget = (m.serializedId && m.serializedId === data.id) || m.id === data.id;
        if (isTarget && m.ack !== data.ack) {
          changed = true;
          return { ...m, ack: data.ack };
        }
        return m;
      });
      return changed ? next : prev;
    });
  };

  return {
    handleMessage,
    handleAIResponse,
    handleMessageAck,
    handlePaymobiResult: onPaymobiResult,
    handlePaymobiError: onPaymobiError,
  };
}
