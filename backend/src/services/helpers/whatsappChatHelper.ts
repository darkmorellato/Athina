import type { Chat, Client, Message } from 'whatsapp-web.js';
import logger from '../../utils/logger.js';

/** Contato da agenda já normalizado por syncPhonebookContacts (whatsappPhonebookHelper). */
export interface PhonebookEntry {
  id?: { _serialized?: string; server?: string; user?: string };
  name?: string;
  pushname?: string;
  number?: string;
  isGroup?: boolean;
  isMyContact?: boolean;
}

/** Mensagem no formato usado pelo painel (contracts: ChatMessage). */
export interface MessagePayload {
  id: string;
  serializedId?: string;
  text: string;
  sender: 'agent' | 'customer';
  fromId: string;
  fromName: string;
  time: string;
  timestamp: number;
  mediaData?: string;
  mediaMimeType?: string;
  quoted?: { body: string; fromMe: boolean };
}

export interface ChatHelperContext {
  client: Client | null;
  state: string;
  phonebookContacts: PhonebookEntry[];
  setPhonebookContacts: (contacts: PhonebookEntry[]) => void;
  contactNameMap: Map<string, string>;
  isSyncingPhonebook: boolean;
  setIsSyncingPhonebook: (val: boolean) => void;
  cachedChats: ChatEntry[] | null;
  setCachedChats: (chats: ChatEntry[] | null) => void;
  lastCacheTime: number;
  setLastCacheTime: (time: number) => void;
  fetchPromise: Promise<ChatEntry[]> | null;
  setFetchPromise: (promise: Promise<ChatEntry[]> | null) => void;
  emit: (event: string, data?: unknown) => void;
}

export interface ChatEntry {
  id: string;
  name: string;
  /** 0 = contato sem conversa; 1 = prévia da última mensagem */
  messages: MessagePayload[];
  timestamp: number;
  /** Não-lidas do WhatsApp (chat.unreadCount) — badge verde na lista do painel */
  unreadCount: number;
}

/** Resolve o melhor nome disponível para um contato/chat */
function resolveName(ctx: ChatHelperContext, serializedId: string, fallback?: string): string {
  return ctx.contactNameMap.get(serializedId) || fallback || serializedId.split('@')[0];
}

/** Formata uma mensagem da lib como payload nosso */
function mapMessage(msg: Message, chatId: string, name: string): MessagePayload {
  const ts = typeof msg.timestamp === 'number' ? msg.timestamp : 0;
  return {
    id: msg.id?.id ?? `${chatId}-${ts}`,
    serializedId: msg.id?._serialized,
    text: msg.body ?? '',
    sender: msg.fromMe ? 'agent' : 'customer',
    fromId: chatId,
    fromName: name,
    time: ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
    timestamp: ts,
  };
}

/**
 * Retorna TODOS os contatos e conversas (como o WhatsApp Web), porém com
 * payload leve: apenas a prévia da última mensagem por conversa.
 * O histórico completo (15 últimas, com "ver anterior") é carregado sob demanda.
 */
export async function getRecentChats(ctx: ChatHelperContext): Promise<ChatEntry[]> {
  const client = ctx.client;
  if (!client || ctx.state !== 'READY') return [];

  if (ctx.fetchPromise) {
    return ctx.fetchPromise;
  }

  const now = Date.now();
  if (ctx.cachedChats && (now - ctx.lastCacheTime < 5000)) {
    return ctx.cachedChats;
  }

  const promise = (async () => {
    try {
      const chats: Chat[] = await client.getChats();
      const entries: ChatEntry[] = [];
      const seen = new Set<string>();

      for (const chat of chats) {
        if (chat.isGroup) continue;
        const id = chat.id._serialized;
        const name = resolveName(ctx, id, chat.name);
        let messages: MessagePayload[] = [];
        let timestamp = 0;

        try {
          const lastMsg = chat.lastMessage as (Message & { isNotification?: boolean }) | undefined;
          if (lastMsg && !lastMsg.isNotification) {
            timestamp = typeof lastMsg.timestamp === 'number' ? lastMsg.timestamp : 0;
            messages = [mapMessage(lastMsg, id, name)];
          }
        } catch {
          // lastMessage pode falhar em chats vazios — segue como contato
        }

        const unreadCount =
          typeof chat.unreadCount === 'number' && chat.unreadCount > 0
            ? Math.floor(chat.unreadCount)
            : 0;
        entries.push({ id, name, messages, timestamp, unreadCount });
        seen.add(id);
      }

      // Contatos do phonebook sem conversa (aparecem na lista, sem mensagens).
      // Filtra apenas contatos SALVOS (isMyContact) e deduplica:
      //  - por nome normalizado
      //  - por NÚMERO de telefone (evita a mesma pessoa aparecer como
      //    conversa @lid e contato @c.us com grafias diferentes)
      try {
        const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        // Extrai o telefone mesmo com formatação (+55 19 97167-0491 → 5519971670491)
        const digitsOf = (s: string) => {
          const d = String(s || '').replace(/\D/g, '');
          return d.length >= 10 && d.length <= 15 ? d : '';
        };
        // Variantes brasileiras com/sem o 9º dígito
        const numberVariants = (d: string): string[] => {
          const out = [d];
          if (d.length === 13 && d.startsWith('55') && d[4] === '9') out.push(d.slice(0, 4) + d.slice(5));
          if (d.length === 12 && d.startsWith('55')) out.push(d.slice(0, 4) + '9' + d.slice(4));
          return out;
        };

        const seenNames = new Set(entries.map((e) => normalize(e.name)));
        const seenNumbers = new Set<string>();
        const addNumber = (raw: string) => {
          const d = digitsOf(raw);
          if (d) for (const v of numberVariants(d)) seenNumbers.add(v);
        };
        for (const e of entries) {
          addNumber(e.name);
          addNumber(e.id.split('@')[0]);
        }

        const allContacts = ctx.phonebookContacts.filter(
          (c) => !c.isGroup && c.id?.server !== 'broadcast'
        );
        const savedContacts = allContacts.filter((c) => c.isMyContact === true);
        const pool = savedContacts.length > 0 ? savedContacts : allContacts;

        let added = 0;
        let skippedByNumber = 0;
        for (const contact of pool) {
          const jid = contact.id?._serialized;
          if (!jid || seen.has(jid)) continue;
          const name = resolveName(ctx, jid, contact.name || contact.pushname || contact.number);
          const nameKey = normalize(name);
          if (!nameKey || seenNames.has(nameKey)) continue;

          const numberKey = digitsOf(contact.number || contact.id?.user || jid.split('@')[0]);
          if (numberKey && numberVariants(numberKey).some((v) => seenNumbers.has(v))) {
            skippedByNumber++;
            continue;
          }

          seenNames.add(nameKey);
          if (numberKey) for (const v of numberVariants(numberKey)) seenNumbers.add(v);
          entries.push({ id: jid, name, messages: [], timestamp: 0, unreadCount: 0 });
          seen.add(jid);
          added++;
        }
        logger.info(
          { total: allContacts.length, saved: savedContacts.length, added, skippedByNumber },
          'Phonebook contacts merged into chat list'
        );
      } catch (contactErr) {
        logger.error(
          { error: contactErr instanceof Error ? contactErr.message : String(contactErr) },
          'Error merging phonebook contacts'
        );
      }

      // Ordenação: conversas recentes primeiro; contatos sem conversa em A-Z
      entries.sort((a, b) => {
        if (a.timestamp && b.timestamp) return b.timestamp - a.timestamp;
        if (a.timestamp) return -1;
        if (b.timestamp) return 1;
        return a.name.localeCompare(b.name, 'pt-BR');
      });

      ctx.setCachedChats(entries);
      ctx.setLastCacheTime(Date.now());
      return entries;
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Error getting active chats');
      return [];
    } finally {
      ctx.setFetchPromise(null);
    }
  })();

  ctx.setFetchPromise(promise);
  return promise;
}

/**
 * Carrega o histórico de uma conversa com paginação por limite crescente.
 * - Abrir a conversa: limit = 15 (apenas as 15 últimas)
 * - "Ver anterior": limit maior (ex.: 30, 45...) — a lib carrega as anteriores
 *   internamente e devolve as N últimas; o frontend mescla por id.
 */
export async function handleRequestChatHistory(
  socket: { emit: (event: 'chat-history-loaded', data: { chatId: string; messages: MessagePayload[]; hasMore: boolean }) => void },
  chatId: string,
  client: Client | null,
  isReady: boolean,
  limit = 15
): Promise<void> {
  try {
    if (isReady && client) {
      const safeLimit = Math.min(Math.max(Math.floor(limit) || 15, 1), 120);
      let chat;
      try {
        chat = await client.getChatById(chatId);
      } catch (chatErr) {
        logger.warn({ chatId, error: chatErr instanceof Error ? chatErr.message : String(chatErr) }, 'Chat not found on WhatsApp servers, returning empty messages');
        socket.emit('chat-history-loaded', { chatId, messages: [], hasMore: false });
        return;
      }
      if (chat) {
        const wwebMsgs = await chat.fetchMessages({ limit: safeLimit });
        const name = chat.name || chatId.split('@')[0];

        const messages = await Promise.all(wwebMsgs.map(async (msg: Message) => {
          let mediaData: string | undefined;
          let mediaMimeType: string | undefined;

          // Citação (reply): só mensagens COM citação custam uma avaliação na
          // página do Puppeteer — no fluxo típico são 0-2 por histórico.
          let quoted: { body: string; fromMe: boolean } | undefined;
          if (msg.hasQuotedMsg) {
            try {
              const q = await msg.getQuotedMessage();
              if (q) quoted = { body: q.body ?? '', fromMe: Boolean(q.fromMe) };
            } catch {
              // citação indisponível — segue sem
            }
          }

          if (msg.hasMedia) {
            try {
              const media = await msg.downloadMedia();
              if (media) {
                // Performance: skip very large media (> ~5MB base64 ≈ 3.7MB raw)
                // to avoid freezing the UI with multi-megabyte data URLs.
                const MAX_MEDIA_BASE64 = 5_000_000;
                if (media.data && media.data.length <= MAX_MEDIA_BASE64) {
                  mediaData = media.data;
                  mediaMimeType = media.mimetype;
                }
              }
            } catch {
              // Ignore media error to avoid breaking chat history loading
            }
          }

          return {
            ...mapMessage(msg, chatId, name),
            mediaData,
            mediaMimeType,
            quoted,
          };
        }));

        messages.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

        socket.emit('chat-history-loaded', {
          chatId,
          messages,
          hasMore: wwebMsgs.length >= safeLimit,
        });
      }
    }
  } catch (err) {
    logger.error({ chatId, error: err instanceof Error ? err.message : String(err) }, 'Error loading chat history');
  }
}
