import { memo, useState, useMemo, useCallback } from 'react';
import { Brain, BarChart3, MessageSquare, Search } from 'lucide-react';
import { ContactList } from './ContactList.tsx';
import { ChatView } from './ChatView.tsx';
import { MessageInput } from './MessageInput.tsx';
import { TrainingTab } from './WhatsAppPanel/TrainingTab.tsx';
import { AnalyticsTab } from './WhatsAppPanel/AnalyticsTab.tsx';
import { QRCodeScreen } from './WhatsAppPanel/QRCodeScreen.tsx';
import { ForwardModal } from './WhatsAppPanel/ForwardModal.tsx';
import { SidebarHeader } from './WhatsAppPanel/SidebarHeader.tsx';
import { classifyContact, isHostile, isDefaultPinned, loadPinnedIds, savePinnedIds } from './WhatsAppPanel/panelHelpers.js';
import { TabBtn } from './WhatsAppPanel/TabBtn.js';
import type { AnalyticsStats, Contact, Message, ReplyTarget, TrainingData } from '../types/index.js';
import type { UnreadMark } from '../hooks/socket/unreadLogic.js';
import type { FlowTextItem, SendFileReplyPayload } from '@shared/contracts.js';
// Note: SectorFilterBar is available but currently not used in the UI

type ActiveTab = 'chats' | 'training' | 'analytics';

interface WhatsAppPanelProps {
  isConnected: boolean;
  qrCodeData: string | null;
  statusMessage: string;
  messages: Message[];
  chatList: Array<{ id: string; name: string; timestamp?: number }>;
  historyMeta: Record<string, { loaded: number; hasMore: boolean; loading: boolean }>;
  onLoadOlder: (chatId: string) => void;
  isAgentTyping: boolean;
  sendReply: (to: string, text: string, isManual?: boolean, quotedMessageId?: string) => void;
  forwardMessage: (serializedId: string, to: string) => void;
  restartWhatsApp: () => void;
  stats: AnalyticsStats;
  refreshStats: () => void;
  resetStats: () => void;
  trainingData: TrainingData;
  updateTrainingRules: (rules: string[]) => void;
  updateTrainingQas: (qas: TrainingData['qaExamples']) => void;
  flowTexts: FlowTextItem[];
  updateFlowText: (key: string, text: string) => void;
  selectedContact: string | null;
  setSelectedContact: (c: string | null) => void;
  inputValue: string;
  setInputValue: (val: string) => void;
  /** Fotos de perfil (jid → url) e o pedido sob demanda */
  avatars: Record<string, string | null>;
  requestAvatars: (jids: string[]) => void;
  /** Não-lidas por contato (badge verde) e o snapshot do chat aberto (divisória) */
  unreadCounts: Record<string, number>;
  unreadMark?: UnreadMark;
  /** Envia imagem (colada/arrastada) como resposta no WhatsApp */
  sendFile: (to: string, base64: string, mimetype: SendFileReplyPayload['mimetype'], filename: string, caption: string) => void;
  /** Devolve o contato selecionado para o atendimento automático da Athina */
  onReleaseTakeover?: (contactId: string) => void;
}

/** Linha da barra lateral: contato + chave de ordenação (atividade). */
type SidebarRow = Contact & { sortKey: number | undefined };

function WhatsAppPanel({
  isConnected, qrCodeData, statusMessage, messages,
  chatList, historyMeta, onLoadOlder,
  isAgentTyping,
  sendReply, forwardMessage, restartWhatsApp, stats, refreshStats, resetStats, trainingData,
  updateTrainingRules, updateTrainingQas, flowTexts, updateFlowText,
  selectedContact, setSelectedContact,
  inputValue, setInputValue,
  avatars, requestAvatars,
  sendFile,
  unreadCounts, unreadMark,
  onReleaseTakeover,
}: WhatsAppPanelProps) {
  const [activeTab, setActiveTab] = useState<ActiveTab>('chats');
  const [searchQuery, setSearchQuery] = useState('');
  /** Mensagem que o operador está respondendo (reply/quote) */
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null);
  // Citação é POR CONVERSA: derivada (sem efeito) — ao trocar de chat o
  // reply simplesmente deixa de estar ativo.
  const activeReplyTo = replyTo && replyTo.contactId === selectedContact ? replyTo : null;

  const handleSendMessage = useCallback(() => {
    if (!inputValue.trim() || !selectedContact) return;
    sendReply(selectedContact, inputValue, true, activeReplyTo?.serializedId);
    setInputValue('');
    setReplyTo(null);
  }, [inputValue, selectedContact, sendReply, setInputValue, activeReplyTo]);

  /** Carrega mensagens anteriores (identidade estável — a prop inline
   *  quebrava o memo do ChatView e re-renderizava a conversa a cada tecla). */
  const handleLoadOlder = useCallback(() => {
    if (selectedContact) onLoadOlder(selectedContact);
  }, [selectedContact, onLoadOlder]);

  /** Inicia reply citando uma mensagem real do WhatsApp (tem serializedId) */
  /** Mensagem escolhida para encaminhar (abre o seletor de conversa) */
  const [forwardSource, setForwardSource] = useState<Message | null>(null);

  const handleReplyMessage = useCallback(
    (m: Message) => {
      if (!m.serializedId || !selectedContact) return;
      setReplyTo({
        id: m.id,
        serializedId: m.serializedId,
        text: m.text || '📎 Mídia',
        fromName: m.sender === 'agent' ? 'você' : m.fromName || 'cliente',
        contactId: selectedContact,
      });
    },
    [selectedContact]
  );

  // Performance: pre-filter messages by contact ONCE per messages change,
  // instead of scanning the full list on every render/keystroke.
  const messagesByContact = useMemo(() => {
    const map = new Map<string, Message[]>();
    for (const m of messages) {
      if (!m.fromId) continue;
      let list = map.get(m.fromId);
      if (!list) {
        list = [];
        map.set(m.fromId, list);
      }
      list.push(m);
    }
    return map;
  }, [messages]);

  // Sidebar: TODOS os contatos e conversas (estilo WhatsApp Web), com prévia
  // da última mensagem. Ordenação: conversas recentes primeiro; contatos sem
  // conversa em ordem alfabética.
  /** null = operador nunca mexeu nos pins → vale o padrão (atendentes). */
  const [pinnedIds, setPinnedIds] = useState<string[] | null>(loadPinnedIds);
  const pinnedSet = useMemo(() => new Set(pinnedIds ?? []), [pinnedIds]);

  const chatTimestamps = useMemo(
    () => new Map(chatList.map((e) => [e.id, e.timestamp ?? 0] as const)),
    [chatList]
  );

  const contacts = useMemo(() => {
    const list: SidebarRow[] = [];
    const seen = new Set<string>();

    const buildItem = (id: string, fallbackName: string) => {
      const contactMsgs = messagesByContact.get(id) ?? [];
      // Sem timestamp = mensagem local criada agora → sempre a mais recente.
      const sorted = contactMsgs.length
        ? contactMsgs
            .map((m, i) => ({ m, i, k: m.timestamp ?? Number.MAX_SAFE_INTEGER }))
            .sort((a, b) => a.k - b.k || a.i - b.i)
            .map((e) => e.m)
        : [];
      const lastMsg = sorted[sorted.length - 1];
      // Última atividade = a mais recente entre a data do chat (WhatsApp) e a
      // última mensagem carregada. Mensagem local (sem timestamp) fica no topo.
      const msgTs = lastMsg ? lastMsg.timestamp || Number.MAX_SAFE_INTEGER : 0;
      const activity = Math.max(msgTs, chatTimestamps.get(id) ?? 0);
      const { className: sectorColor, label: sector, sectorKey } =
        classifyContact();
      return {
        id,
        name: lastMsg?.fromName || fallbackName || id.split('@')[0],
        lastText: lastMsg?.text || '',
        time: lastMsg?.time || '',
        unread: unreadCounts[id] ?? 0,
        isHostile: contactMsgs.some(isHostile),
        sector,
        sectorColor,
        sectorKey,
        // Conversa SEM mensagens (contato da agenda) → undefined: fica no FIM
        // da lista. Com mensagem mas sem timestamp (mensagem local/nova) →
        // conta como mais recente (sobe pro topo, como no WhatsApp).
        sortKey: activity > 0 ? activity : undefined,
        pinned: pinnedIds === null ? isDefaultPinned(id) : pinnedSet.has(id),
      };
    };

    for (const entry of chatList) {
      seen.add(entry.id);
      list.push(buildItem(entry.id, entry.name));
    }
    // Conversas que chegaram depois do último chats-loaded
    for (const [id] of messagesByContact.entries()) {
      if (!seen.has(id)) {
        seen.add(id);
        list.push(buildItem(id, ''));
      }
    }

    // Estilo WhatsApp Web:
    //  1º) conversas primeiro — mais recentes no topo;
    //  2º) contatos SEM conversa (agenda) no fim, em ordem alfabética.
    list.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const aHasChat = a.sortKey !== undefined;
      const bHasChat = b.sortKey !== undefined;
      if (aHasChat !== bHasChat) return aHasChat ? -1 : 1;
      if (a.sortKey !== undefined && b.sortKey !== undefined && a.sortKey !== b.sortKey) {
        return b.sortKey - a.sortKey;
      }
      return String(a.name).localeCompare(String(b.name), 'pt-BR');
    });

    return list;
  }, [messagesByContact, chatList, chatTimestamps, unreadCounts, pinnedIds, pinnedSet]);

  const togglePin = useCallback((id: string) => {
    setPinnedIds((prev) => {
      const current = prev ?? contacts.filter((c) => isDefaultPinned(c.id)).map((c) => c.id);
      const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
      savePinnedIds(next);
      return next;
    });
  }, [contacts]);

  const selectedMessages = useMemo(() => {
    if (!selectedContact) return [];
    const bucket = messagesByContact.get(selectedContact) ?? [];
    // Mensagens SEM timestamp foram criadas localmente pelo painel — são as
    // mais recentes e entram no FINAL (antes `?? 0` as mandava para o topo,
    // fora da vista, e o usuário só via tudo ao trocar de conversa e voltar).
    // Valor fixo (sem Date.now()) mantém o render puro/idempotente.
    return bucket
      .map((m, i) => ({ m, i, k: m.timestamp ?? Number.MAX_SAFE_INTEGER }))
      .sort((a, b) => a.k - b.k || a.i - b.i)
      .map((e) => e.m);
  }, [messagesByContact, selectedContact]);

  const selectedMeta = selectedContact ? historyMeta[selectedContact] : undefined;

  const filteredContacts = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    let result = contacts;
    if (q) {
      result = contacts.filter((c) =>
        c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)
      );
    }

    const cleanNum = searchQuery.replace(/[^\d]/g, '').trim();
    if (cleanNum.length >= 8 && cleanNum.length <= 15) {
      const exists = contacts.some((c) => c.id.includes(cleanNum));
      if (!exists) {
        const virtualJid = `${cleanNum}@c.us`;
        result = [
          {
            sortKey: undefined,
            id: virtualJid,
            name: `Iniciar Conversa: +${cleanNum}`,
            lastText: 'Clique para abrir conversa...',
            time: '',
            isHostile: false,
            sector: 'Suporte',
            sectorColor: 'bg-blue-100 text-blue-800 border border-blue-200',
            sectorKey: 'suporte',
            unread: 0,
          },
          ...result,
        ];
      }
    }
    return result;
  }, [contacts, searchQuery]);

  return (
    <div className="flex flex-col bg-white rounded-3xl shadow-2xl overflow-hidden
      border border-gray-200 relative h-full">
      {/* Accent bar */}
      <div className="absolute top-0 left-0 right-0 h-1 bg-linear-to-r
        from-[#00a884] to-[#00d2a0] z-20" />

      {/* Tab Navigation */}
      <div className="flex bg-gray-50 p-1.5 shadow-inner border-b border-gray-250
        gap-1 w-full shrink-0">
        <TabBtn icon={<MessageSquare size={13} />} label="Chats"
          active={activeTab === 'chats'} color="emerald"
          onClick={() => setActiveTab('chats')} />
        <TabBtn icon={<Brain size={13} />} label="Treinamento"
          active={activeTab === 'training'} color="indigo"
          onClick={() => setActiveTab('training')} />
        <TabBtn icon={<BarChart3 size={13} />} label="Métricas"
          active={activeTab === 'analytics'} color="violet"
          onClick={() => setActiveTab('analytics')} />
      </div>

      {/* Content */}
      {activeTab === 'chats' ? (
        !isConnected ? (
          <QRCodeScreen qrCodeData={qrCodeData} statusMessage={statusMessage}
            onRestart={restartWhatsApp} />
        ) : (
          <div className="flex flex-1 overflow-hidden">
            {/* Sidebar */}
            <div className="w-80 border-r border-gray-200 flex flex-col bg-white shrink-0">
              <SidebarHeader />
              <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 flex items-center shrink-0">
                <div className="relative flex-1">
                  <input
                    type="text"
                    aria-label="Buscar conversa"
                    placeholder="Buscar conversa pelo nome ou número..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setSearchQuery('');
                    }}
                    className="w-full bg-white pl-8 pr-3 py-1.5 rounded-xl text-[11px] border border-gray-300
                      focus:outline-hidden focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500
                      transition-all font-semibold text-gray-700 placeholder-gray-400 shadow-xs"
                  />
                  <Search className="absolute left-2.5 top-2.5 text-gray-450" size={12} />
                </div>
              </div>
              <ContactList contacts={filteredContacts} selectedContact={selectedContact}
                onSelectContact={setSelectedContact} resetScrollKey={searchQuery}
                avatars={avatars} onRequestAvatars={requestAvatars} onTogglePin={togglePin} />
            </div>
            {/* Chat Area */}
            <div className="wa-chat flex-1 flex flex-col bg-[#f5f1eb] relative overflow-hidden">
              <ChatView messages={selectedMessages} selectedContact={selectedContact}
                unreadMark={unreadMark}
                avatarUrl={selectedContact ? avatars[selectedContact] : undefined}
                onReplyMessage={handleReplyMessage}
                onForwardMessage={setForwardSource}
                isAgentTyping={isAgentTyping}
                hasMore={selectedMeta?.hasMore ?? false}
                isLoadingOlder={selectedMeta?.loading ?? false}
                historyLoaded={Boolean(selectedMeta && !selectedMeta.loading)}
                onLoadOlder={handleLoadOlder}
                onReleaseTakeover={onReleaseTakeover} />
              {forwardSource?.serializedId && (
                <ForwardModal
                  contacts={contacts}
                  onClose={() => setForwardSource(null)}
                  onPick={(to) => {
                    forwardMessage(forwardSource.serializedId!, to);
                    setForwardSource(null);
                  }}
                />
              )}
              {selectedContact && (
                <MessageInput value={inputValue} onChange={setInputValue}
                  onSend={handleSendMessage}
                  replyTo={activeReplyTo}
                  onCancelReply={() => setReplyTo(null)}
                  onSendFile={(base64, mimetype, filename, caption) =>
                    sendFile(selectedContact, base64, mimetype, filename, caption)} />
              )}
            </div>
          </div>
        )
      ) : activeTab === 'training' ? (
        <TrainingTab trainingData={trainingData}
          updateTrainingRules={updateTrainingRules}
          updateTrainingQas={updateTrainingQas}
          flowTexts={flowTexts}
          updateFlowText={updateFlowText} />
      ) : (
        <AnalyticsTab stats={stats} onRefresh={refreshStats} onReset={resetStats} />
      )}
    </div>
  );
}

export default memo(WhatsAppPanel);