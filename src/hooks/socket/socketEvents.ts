/**
 * @fileoverview Socket.IO event handlers registration for the useSocket hook.
 * Handles all real-time communication with the backend.
 */
import type { Socket } from 'socket.io-client';
import type { ClientToServerEvents, LoadedChat, ServerToClientEvents } from '@shared/contracts.js';
import type { Message, WAMessage, AgentLog } from '../../types/index.js';
import type { AnalyticsStats } from '../../types/index.js';
import { createSocketHandlers } from './socketHandlers.js';

export interface SocketEventHandlers {
  onConnect: () => void;
  onDisconnect: () => void;
  onServerStatus: (status: string) => void;
  onQR: (qr: string) => void;
  onReady: () => void;
  onDisconnected: () => void;
  onMessage: (msg: WAMessage) => void;
  onAIResponse: (data: { text: string; contactId: string; isSentDirectly?: boolean }) => void;
  onAIError: (data: { message: string }) => void;
  onStats: (data: AnalyticsStats) => void;
  onAgentMode: (data: { serverAutoReply: boolean }) => void;
  onTrainingData: (data: import('../../types/index.js').TrainingData) => void;
  onTrainingUpdated: (data: import('../../types/index.js').TrainingData) => void;
  addLog: (text: string, type?: AgentLog['type']) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setChatList: React.Dispatch<React.SetStateAction<Array<{ id: string; name: string }>>>;
  setHistoryMeta: React.Dispatch<
    React.SetStateAction<Record<string, { loaded: number; hasMore: boolean; loading: boolean }>>
  >;
  setIsAgentTyping: React.Dispatch<React.SetStateAction<boolean>>;
  quickRepliesRef: React.MutableRefObject<string[]>;
  agentPersonaRef: React.MutableRefObject<string>;
  selectedModelRef: React.MutableRefObject<string>;
  isAgentActiveRef: React.MutableRefObject<boolean>;
  serverAutoReplyRef: React.MutableRefObject<boolean>;
  messagesRef: React.MutableRefObject<Message[]>;
  /** Não-lidas: baseline do backend + mensagens ao vivo (ver unreadLogic.ts) */
  ingestChatsUnread: (chats: Array<{ id: string; unreadCount?: number }>) => void;
  ingestIncomingUnread: (chatId: string, msgId: string, isCustomer: boolean) => void;
  socket: Socket<ServerToClientEvents, ClientToServerEvents>;
}

export function setupSocketEvents(
  socket: Socket<ServerToClientEvents, ClientToServerEvents>,
  handlers: SocketEventHandlers
): () => void {
  socket.emit('request-status');
  const {
    onConnect, onDisconnect, onServerStatus, onQR, onReady,
    onDisconnected, onAIError, onStats, onTrainingData, onTrainingUpdated,
  } = handlers;

  const {
    handleMessage,
    handleAIResponse,
    handleMessageAck,
    handlePaymobiResult,
    handlePaymobiError,
  } = createSocketHandlers(socket, handlers);

  const handleChatsLoaded = (loadedChats: LoadedChat[]) => {
    // Lista completa de contatos + conversas (sidebar estilo WhatsApp Web)
    handlers.setChatList(loadedChats.map((c) => ({ id: c.id, name: c.name })));

    // Não-lidas: baseline do WhatsApp (nunca regride a contagem ao vivo)
    handlers.ingestChatsUnread(loadedChats);

    // Merge por id — preserva histórico já carregado e evita duplicatas
    handlers.setMessages((prev) => {
      const byId = new Map<string, Message>();
      for (const m of prev) byId.set(m.id, m);
      for (const chat of loadedChats) {
        for (const m of chat.messages ?? []) byId.set(m.id, m);
      }
      return Array.from(byId.values());
    });
    handlers.addLog(`📬 ${loadedChats.length} contatos/conversas carregados.`, 'success');
  };

  const handleChatHistoryLoaded = (data: { chatId: string; messages: Message[]; hasMore?: boolean }) => {
    const incoming = data.messages ?? [];
    handlers.setMessages((prev) => {
      const byId = new Map<string, Message>();
      for (const m of prev) byId.set(m.id, m);
      for (const m of incoming) byId.set(m.id, m);
      return Array.from(byId.values());
    });
    handlers.setHistoryMeta((prev) => ({
      ...prev,
      [data.chatId]: {
        loaded: incoming.length,
        hasMore: Boolean(data.hasMore),
        loading: false,
      },
    }));
    handlers.addLog(`💬 Histórico de ${data.chatId.split('@')[0]} (${incoming.length} mensagens)`, 'info');
  };

  // Register all socket listeners
  socket.on('connect', onConnect);
  socket.on('disconnect', onDisconnect);
  socket.on('server-status', onServerStatus);
  socket.on('whatsapp-qr', onQR);
  socket.on('whatsapp-ready', onReady);
  socket.on('whatsapp-disconnected', onDisconnected);
  socket.on('whatsapp-message', handleMessage);
  socket.on('ai-response', handleAIResponse);
  socket.on('ai-error', onAIError);
  socket.on('analytics-stats', onStats);
  socket.on('agent-mode', handlers.onAgentMode);
  socket.on('training-data', onTrainingData);
  socket.on('training-data-updated', onTrainingUpdated);
  socket.on('paymobi-result', handlePaymobiResult);
  socket.on('paymobi-error', handlePaymobiError);
  socket.on('chats-loaded', handleChatsLoaded);
  socket.on('chat-history-loaded', handleChatHistoryLoaded);
  socket.on('message-ack', handleMessageAck);

  // Envio recusado (WhatsApp não está pronto): avisa o operador no console
  // do painel em vez do antigo descarte silencioso.
  const handleSendFailed = (data: { to: string; reason: string }): void => {
    handlers.addLog(
      `⚠️ Mensagem para ${String(data?.to ?? '').split('@')[0]} NÃO foi enviada (WhatsApp indisponível — verifique a conexão).`,
      'error'
    );
  };
  socket.on('send-failed', handleSendFailed);

  // Cleanup function
  return () => {
    socket.off('connect', onConnect);
    socket.off('disconnect', onDisconnect);
    socket.off('server-status', onServerStatus);
    socket.off('whatsapp-qr', onQR);
    socket.off('whatsapp-ready', onReady);
    socket.off('whatsapp-disconnected', onDisconnected);
    socket.off('whatsapp-message', handleMessage);
    socket.off('ai-response', handleAIResponse);
    socket.off('ai-error', onAIError);
    socket.off('analytics-stats', onStats);
    socket.off('agent-mode', handlers.onAgentMode);
    socket.off('training-data', onTrainingData);
    socket.off('training-data-updated', onTrainingUpdated);
    socket.off('paymobi-result', handlePaymobiResult);
    socket.off('paymobi-error', handlePaymobiError);
    socket.off('chats-loaded', handleChatsLoaded);
    socket.off('chat-history-loaded', handleChatHistoryLoaded);
    socket.off('message-ack', handleMessageAck);
    socket.off('send-failed', handleSendFailed);
  };
}
