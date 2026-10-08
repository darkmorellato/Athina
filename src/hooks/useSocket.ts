/// <reference types="vite/client" />
/**
 * @fileoverview Main Socket.IO hook for Athina Agent.
 * Manages WhatsApp connection, AI responses, real-time messaging,
 * server-side chat states, and analytics.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import {
  AgentLog,
  AnalyticsStats,
  DEFAULT_PERSONA,
  DEFAULT_QUICK_REPLIES,
  DEFAULT_QA_EXAMPLES,
  DEFAULT_CUSTOM_RULES,
  Message,
  ServerStatus,
  TrainingData,
} from '../types/index.js';
import { setupSocketEvents } from './socket/socketEvents.js';
import { INITIAL_LOGS, DEFAULT_STATS } from './socket/socketHelpers.js';

// Admin token for privileged operations (e.g. restart). Priority: localStorage > build-time env.
// Set via: localStorage.setItem('athina_admin_token', '<your ADMIN_SECRET>') in the browser console.
const getAdminToken = (): string | undefined => {
  try {
    return localStorage.getItem('athina_admin_token') || import.meta.env.VITE_ADMIN_TOKEN || undefined;
  } catch {
    return import.meta.env.VITE_ADMIN_TOKEN || undefined;
  }
};

const socket: Socket = io(
  import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001',
  {
    auth: getAdminToken() ? { token: getAdminToken() } : undefined,
  }
);

export interface ChatListEntry {
  id: string;
  name: string;
}

export interface HistoryMeta {
  loaded: number;
  hasMore: boolean;
  loading: boolean;
}

const INITIAL_HISTORY_LIMIT = 15;
const HISTORY_STEP = 15;
const HISTORY_MAX = 120;

export default function useSocket() {
  const [isConnected, setIsConnected] = useState(false);
  const [isAgentActive, setIsAgentActive] = useState(true);
  const [audioMode, setAudioMode] = useState(false);
  const [qrCodeData, setQrCodeData] = useState<string | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerStatus>('connecting');
  const [statusMessage, setStatusMessage] = useState('A inicializar o sistema...');
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatList, setChatList] = useState<ChatListEntry[]>([]);
  const [historyMeta, setHistoryMeta] = useState<Record<string, HistoryMeta>>({});
  const [isAgentTyping, setIsAgentTyping] = useState(false);
  const [agentLogs, setAgentLogs] = useState<AgentLog[]>(INITIAL_LOGS);
  const [selectedModel, setSelectedModel] = useState(
    'nvidia/nemotron-3.5-lightning-30b-a3b'
  );
  const [agentPersona, setAgentPersona] = useState(DEFAULT_PERSONA);
  const [quickReplies, setQuickReplies] = useState(DEFAULT_QUICK_REPLIES);
  const [stats, setStats] = useState<AnalyticsStats>(DEFAULT_STATS);
  const [trainingData, setTrainingData] = useState<TrainingData>({
    customRules: DEFAULT_CUSTOM_RULES,
    qaExamples: DEFAULT_QA_EXAMPLES,
  });
  /** Fotos de perfil: jid → url (null = sem foto / privacidade) */
  const [avatars, setAvatars] = useState<Record<string, string | null>>({});
  const avatarsRef = useRef<Record<string, string | null>>(avatars);
  const pendingAvatarsRef = useRef<Set<string>>(new Set());
  const avatarTimerRef = useRef<number | null>(null);

  // Refs for live values without re-creating closures
  const isAgentActiveRef = useRef(isAgentActive);
  const selectedModelRef = useRef(selectedModel);
  const agentPersonaRef = useRef(agentPersona);
  const quickRepliesRef = useRef(quickReplies);
  const messagesRef = useRef(messages);
  const serverAutoReplyRef = useRef(false);

  useEffect(() => { isAgentActiveRef.current = isAgentActive; }, [isAgentActive]);
  useEffect(() => { selectedModelRef.current = selectedModel; }, [selectedModel]);
  useEffect(() => { agentPersonaRef.current = agentPersona; }, [agentPersona]);
  useEffect(() => { quickRepliesRef.current = quickReplies; }, [quickReplies]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { avatarsRef.current = avatars; }, [avatars]);

  const addLog = useCallback((text: string, type: AgentLog['type'] = 'info') => {
    setAgentLogs((prev) => {
      const next = [
        ...prev,
        {
          id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          text,
          type,
          time: new Date().toLocaleTimeString(),
        },
      ];
      // Performance: cap log history to avoid unbounded growth in long sessions
      const MAX_LOGS = 300;
      return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next;
    });
  }, []);

  useEffect(() => {
    const cleanup = setupSocketEvents(socket, {
      onConnect: () => {
        setServerStatus('connected');
        addLog('Conectado ao Servidor Bridge.', 'success');
        socket.emit('request-status');
      },
      onDisconnect: () => {
        setServerStatus('error');
        setIsConnected(false);
        addLog('Desconectado do Servidor.', 'error');
      },
      onServerStatus: (status: string) => {
        setStatusMessage(status);
        addLog(`Status: ${status}`, 'info');
      },
      onQR: (qr: string) => {
        setQrCodeData(qr);
        setIsConnected(false);
        setStatusMessage('Escaneie o QR Code abaixo para conectar');
        addLog('Novo QR Code gerado.', 'info');
      },
      onReady: () => {
        setIsConnected(true);
        setQrCodeData(null);
        setStatusMessage('Conectado!');
        addLog('WhatsApp pronto para uso!', 'success');
      },
      onDisconnected: () => {
        setIsConnected(false);
        addLog('WhatsApp desconectado.', 'error');
      },
      onMessage: () => { /* handled inside setupSocketEvents */ },
      onAIResponse: () => { /* handled inside setupSocketEvents */ },
      onAIError: (data) => {
        setIsAgentTyping(false);
        addLog(`Erro na IA: ${data.message}`, 'error');
      },
      onStats: setStats,
      onAgentMode: (data) => {
        serverAutoReplyRef.current = Boolean(data?.serverAutoReply);
        if (data?.serverAutoReply) {
          addLog('🤖 Modo autônomo ATIVO no servidor — o painel entra em modo monitor (sem respostas duplicadas).', 'info');
        }
      },
      onTrainingData: (data) => setTrainingData(data ?? { customRules: [], qaExamples: [] }),
      onTrainingUpdated: (data) => {
        setTrainingData(data ?? { customRules: [], qaExamples: [] });
        addLog('🧠 Cérebro da Athina atualizado e sincronizado!', 'success');
      },
      addLog,
      setMessages,
      setChatList,
      setHistoryMeta,
      setIsAgentTyping,
      quickRepliesRef,
      agentPersonaRef,
      selectedModelRef,
      isAgentActiveRef,
      serverAutoReplyRef,
      messagesRef,
      socket,
    });

    const handleAvatars = (data: { avatars?: Record<string, string | null> }) => {
      const incoming = data?.avatars ?? {};
      if (Object.keys(incoming).length > 0) {
        setAvatars((prev) => ({ ...prev, ...incoming }));
      }
    };
    socket.on('contact-avatars', handleAvatars);

    return () => {
      cleanup();
      socket.off('contact-avatars', handleAvatars);
    };
  }, [addLog]);

  /**
   * Pede fotos de perfil para os jids (lotes de 60, debounce 200ms).
   * Jids já conhecidos (url ou null) são ignorados — sem refetch em loop.
   */
  const requestAvatars = useCallback((jids: string[]) => {
    const known = avatarsRef.current;
    for (const jid of jids) {
      if (jid && !(jid in known)) pendingAvatarsRef.current.add(jid);
    }
    if (pendingAvatarsRef.current.size === 0 || avatarTimerRef.current !== null) return;
    avatarTimerRef.current = window.setTimeout(() => {
      avatarTimerRef.current = null;
      const all = Array.from(pendingAvatarsRef.current);
      pendingAvatarsRef.current.clear();
      for (let i = 0; i < all.length; i += 60) {
        socket.emit('get-contact-avatars', { jids: all.slice(i, i + 60) });
      }
    }, 200);
  }, []);

  const sendReply = useCallback(
    (to: string, text: string, isManual = false, quotedMessageId?: string) => {
      socket.emit('send-reply', {
        to,
        text,
        isManual,
        ...(quotedMessageId ? { quotedMessageId } : {}),
      });
    },
    []
  );

  const loadChatHistory = useCallback((chatId: string) => {
    setHistoryMeta((prev) => ({
      ...prev,
      [chatId]: { loaded: prev[chatId]?.loaded ?? 0, hasMore: true, loading: true },
    }));
    socket.emit('request-chat-history', { chatId, limit: INITIAL_HISTORY_LIMIT });
  }, []);

  /** Carrega mensagens anteriores (paginação por limite crescente) */
  const loadOlderMessages = useCallback((chatId: string) => {
    setHistoryMeta((prev) => {
      const meta = prev[chatId] ?? { loaded: INITIAL_HISTORY_LIMIT, hasMore: true, loading: false };
      const nextLimit = Math.min(meta.loaded + HISTORY_STEP, HISTORY_MAX);
      socket.emit('request-chat-history', { chatId, limit: nextLimit });
      return { ...prev, [chatId]: { ...meta, loading: true } };
    });
  }, []);

  /** Envia imagem colada/arrastada como mensagem de WhatsApp (com legenda). */
  const sendImage = useCallback(
    (to: string, base64: string, mimetype: string, caption = '') => {
      socket.emit('send-image-reply', {
        to,
        base64,
        mimetype,
        caption: caption.slice(0, 1024), // limite de legenda do WhatsApp
      });
    },
    []
  );

  const restartWhatsApp = useCallback(() => {
    socket.emit('restart-whatsapp');
  }, []);

  const toggleAudioMode = useCallback((enabled: boolean) => {
    socket.emit('toggle-audio-mode', enabled);
    setAudioMode(enabled);
  }, []);

  const clearLogs = useCallback(() => {
    setAgentLogs([{ id: 'init', type: 'info', text: 'Logs limpos.', time: new Date().toLocaleTimeString() }]);
  }, []);

  const updateTrainingRules = useCallback((rules: string[]) => {
    socket.emit('update-training-rules', rules);
  }, []);

  const updateTrainingQas = useCallback((qas: TrainingData['qaExamples']) => {
    socket.emit('update-training-qas', qas);
  }, []);

  const refreshStats = useCallback(() => {
    socket.emit('get-stats');
  }, []);

  const resetStats = useCallback(() => {
    socket.emit('reset-stats');
  }, []);

  return {
    socket,
    isConnected,
    isAgentActive,
    setIsAgentActive,
    audioMode,
    toggleAudioMode,
    qrCodeData,
    serverStatus,
    statusMessage,
    messages,
    chatList,
    historyMeta,
    isAgentTyping,
    agentLogs,
    selectedModel,
    setSelectedModel,
    agentPersona,
    setAgentPersona,
    quickReplies,
    setQuickReplies,
    stats,
    trainingData,
    addLog,
    sendReply,
    sendImage,
    avatars,
    requestAvatars,
    loadChatHistory,
    loadOlderMessages,
    restartWhatsApp,
    clearLogs,
    updateTrainingRules,
    updateTrainingQas,
    refreshStats,
    resetStats,
  };
}
