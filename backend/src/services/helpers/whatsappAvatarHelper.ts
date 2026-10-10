/**
 * @fileoverview Resolução de foto de perfil dos contatos (avatar) com cache.
 *
 * getProfilePicUrl() é uma chamada pela ponte Puppeteer do whatsapp-web.js —
 * caro para milhares de contatos. Por isso:
 *  - cache LRU em memória (máx. 5000 jids, TTL 6h, inclusive cache NEGATIVO:
 *    foto oculta por privacidade → não tenta de novo até expirar);
 *  - resolução em lotes pequenos (concorrência 3) para não martelar o
 *    WhatsApp Web nem estourar rate limit.
 * O LRU substituiu um Map sem limite (que só expirava ao reconsultar o mesmo
 * JID — em sessões longas crescia sem teto).
 */
import { LRUCache } from 'lru-cache';
import logger from '../../utils/logger.js';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas
const CACHE_MAX = 5000;
const CONCURRENCY = 3;

type AvatarCacheEntry = { url: string | null };

const cache = new LRUCache<string, AvatarCacheEntry>({
  max: CACHE_MAX,
  ttl: CACHE_TTL_MS,
});

export async function resolveAvatars(
  client: unknown,
  jids: string[]
): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  if (!client) return result;

  const missing: string[] = [];
  for (const jid of jids) {
    const hit = cache.get(jid);
    if (hit !== undefined) {
      // url string = foto; url null = sabidamente sem foto (cache negativo)
      result[jid] = hit.url;
    } else {
      missing.push(jid);
    }
  }

  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    const chunk = missing.slice(i, i + CONCURRENCY);
    const resolved = await Promise.all(
      chunk.map(async (jid) => {
        try {
          const c = client as {
            getContactById: (id: string) => Promise<{
              getProfilePicUrl?: () => Promise<string | null | undefined>;
            }>;
          };
          const contact = await c.getContactById(jid);
          const url = await contact?.getProfilePicUrl?.();
          return [jid, url ?? null] as const;
        } catch {
          // Foto oculta (privacidade) ou contato inexistente — cacheia o negativo
          return [jid, null] as const;
        }
      })
    );
    for (const [jid, url] of resolved) {
      cache.set(jid, { url });
      result[jid] = url;
    }
  }

  const found = Object.values(result).filter(Boolean).length;
  logger.debug({ requested: jids.length, found, cached: jids.length - missing.length }, 'Avatars resolved');
  return result;
}

/** Invalida o cache inteiro (chamar em reconnect/READY para não servir links expirados). */
export function clearAvatarCache(): void {
  cache.clear();
}
