/**
 * @fileoverview Analytics e estatísticas com Redis + espelho DURÁVEL em SQLite.
 *
 * Sem Redis (caso atual): o SQLite mantém os contadores entre reinícios —
 * o antigo fallback só em memória perdia tudo a cada restart.
 * Com Redis: o Redis continua sendo a fonte primária (TTL de 7 dias).
 */
import type { DatabaseSync } from 'node:sqlite';
import redisService from './RedisService.js';
import { getDb } from './db.js';
import logger from '../utils/logger.js';

export interface AnalyticsStats {
  totalChats: number;
  autoResolved: number;
  humanInterventions: number;
  ocrScans: number;
  ocrValids: number;
  ocrSuspicious: number;
  intentCounts: Record<string, number>;
}

const STATS_KEY = 'analytics:stats';
const STATS_TTL_SECONDS = 604800; // 7 days
const MAX_TRACKED_INTENTS = 100; // Security fix: bound intent map growth

const DEFAULT_STATS: AnalyticsStats = {
  totalChats: 0,
  autoResolved: 0,
  humanInterventions: 0,
  ocrScans: 0,
  ocrValids: 0,
  ocrSuspicious: 0,
  intentCounts: {},
};

const NUMERIC_KEYS: Array<keyof Omit<AnalyticsStats, 'intentCounts'>> = [
  'totalChats',
  'autoResolved',
  'humanInterventions',
  'ocrScans',
  'ocrValids',
  'ocrSuspicious',
];

function sanitizeStats(raw: unknown): AnalyticsStats {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_STATS };
  const r = raw as Record<string, unknown>;
  const stats: AnalyticsStats = { ...DEFAULT_STATS };
  for (const key of NUMERIC_KEYS) {
    const val = r[key];
    stats[key] = typeof val === 'number' && Number.isFinite(val) ? val : 0;
  }
  if (r.intentCounts && typeof r.intentCounts === 'object') {
    stats.intentCounts = r.intentCounts as Record<string, number>;
  }
  return stats;
}

function safeParseStats(raw: string): AnalyticsStats {
  try {
    return sanitizeStats(JSON.parse(raw));
  } catch {
    logger.warn('Failed to parse analytics JSON, resetting to defaults');
    return { ...DEFAULT_STATS };
  }
}

export class AnalyticsService {
  private db: DatabaseSync | null;
  /** Espelho local hidratado do SQLite (durável) + atualizações em tempo real. */
  private memoryStats: AnalyticsStats;

  constructor(db: DatabaseSync | null) {
    this.db = db;
    this.memoryStats = this.loadFromDb();
  }

  private loadFromDb(): AnalyticsStats {
    const stats: AnalyticsStats = { ...DEFAULT_STATS, intentCounts: {} };
    try {
      if (!this.db) return stats;
      const rows = this.db.prepare('SELECT key, value FROM analytics_stats').all() as Array<{
        key: string;
        value: number;
      }>;
      for (const row of rows) {
        if ((NUMERIC_KEYS as string[]).includes(row.key)) {
          stats[row.key as (typeof NUMERIC_KEYS)[number]] = Number(row.value) || 0;
        }
      }
      const intents = this.db.prepare('SELECT intent, count FROM analytics_intents').all() as Array<{
        intent: string;
        count: number;
      }>;
      for (const it of intents) stats.intentCounts[it.intent] = Number(it.count) || 0;
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'Falha ao carregar analytics do SQLite'
      );
    }
    return stats;
  }

  private persistValue(key: string, value: number): void {
    try {
      this.db
        ?.prepare(
          'INSERT INTO analytics_stats (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
        )
        .run(key, Math.max(0, Math.trunc(value)));
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err), key }, 'Analytics persist failed');
    }
  }

  private persistIncrement(key: string, amount: number): void {
    try {
      this.db
        ?.prepare(
          'INSERT INTO analytics_stats (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = analytics_stats.value + excluded.value'
        )
        .run(key, Math.trunc(amount));
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err), key }, 'Analytics persist failed');
    }
  }

  private persistIntentIncrement(intent: string): void {
    try {
      this.db
        ?.prepare(
          'INSERT INTO analytics_intents (intent, count) VALUES (?, 1) ON CONFLICT(intent) DO UPDATE SET count = count + 1'
        )
        .run(intent);
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err), intent },
        'Analytics intent persist failed'
      );
    }
  }

  /**
   * Get current analytics stats.
   */
  /** Snapshot do espelho durável (SQLite) para hidratar leituras. */
  private snapshotStats(): AnalyticsStats {
    return { ...this.memoryStats, intentCounts: { ...this.memoryStats.intentCounts } };
  }

  async getStats(): Promise<AnalyticsStats> {
    return redisService.safeExecute(
      async () => {
        const raw = await redisService.client.get(STATS_KEY);
        // Redis vazio (expirou/limpou): hidrata do espelho SQLite em vez de
        // zerar — antes o primeiro increment gravava DEFAULT+1 e "engolia"
        // o histórico durável.
        if (!raw) return this.snapshotStats();
        return safeParseStats(raw);
      },
      this.snapshotStats()
    );
  }

  /**
   * Update stats with partial data.
   * Security fix: atomic read-modify-write using WATCH/MULTI/EXEC with retries.
   */
  async updateStats(updates: Partial<AnalyticsStats>): Promise<void> {
    // Always update durable mirror
    this.memoryStats = {
      ...this.memoryStats,
      ...updates,
      intentCounts: {
        ...this.memoryStats.intentCounts,
        ...(updates.intentCounts ?? {}),
      },
    };

    for (const key of NUMERIC_KEYS) {
      const val = updates[key];
      if (typeof val === 'number') this.persistValue(key, val);
    }
    if (updates.intentCounts) {
      this.persistIntentsAbsolute(updates.intentCounts);
    }

    await this.atomicUpdate((current) => {
      const newStats: AnalyticsStats = {
        ...current,
        ...updates,
        intentCounts: {
          ...current.intentCounts,
          ...(updates.intentCounts ?? {}),
        },
      };
      return newStats;
    });
  }

  private persistIntentsAbsolute(intentCounts: Record<string, number>): void {
    try {
      const upsert = this.db?.prepare(
        'INSERT INTO analytics_intents (intent, count) VALUES (?, ?) ON CONFLICT(intent) DO UPDATE SET count = excluded.count'
      );
      if (!upsert) return;
      for (const [intent, count] of Object.entries(intentCounts)) {
        upsert.run(intent.slice(0, 100), Math.max(0, Math.trunc(count)));
      }
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Analytics intents persist failed');
    }
  }

  /**
   * Increment a specific stat counter.
   * Security fix: atomic via WATCH/MULTI/EXEC (Redis) + espelho SQLite.
   */
  async increment(stat: keyof Omit<AnalyticsStats, 'intentCounts'>, amount = 1): Promise<void> {
    this.memoryStats[stat] = (this.memoryStats[stat] as number) + amount;
    this.persistIncrement(stat, amount);

    await this.atomicUpdate((current) => {
      const next = { ...current };
      next[stat] = (next[stat] as number) + amount;
      return next;
    });
  }

  /**
   * Track an intent classification.
   * Security fix: atomic update and bounded number of tracked intents.
   */
  async trackIntent(intent: string): Promise<void> {
    const key = intent.slice(0, 100);

    if (
      this.memoryStats.intentCounts[key] !== undefined ||
      Object.keys(this.memoryStats.intentCounts).length < MAX_TRACKED_INTENTS
    ) {
      this.memoryStats.intentCounts[key] = (this.memoryStats.intentCounts[key] || 0) + 1;
      this.persistIntentIncrement(key);
    }

    await this.atomicUpdate((current) => {
      const intentCounts = { ...current.intentCounts };
      if (
        intentCounts[key] !== undefined ||
        Object.keys(intentCounts).length < MAX_TRACKED_INTENTS
      ) {
        intentCounts[key] = (intentCounts[key] || 0) + 1;
      }
      return { ...current, intentCounts };
    });
  }

  /**
   * Reset all stats (memory + SQLite + Redis).
   */
  async resetStats(): Promise<void> {
    this.memoryStats = { ...DEFAULT_STATS, intentCounts: {} };
    try {
      this.db?.prepare('DELETE FROM analytics_stats').run();
      this.db?.prepare('DELETE FROM analytics_intents').run();
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Analytics reset persist failed');
    }

    await redisService.safeExecute(
      async () => {
        await redisService.client.setex(STATS_KEY, STATS_TTL_SECONDS, JSON.stringify(DEFAULT_STATS));
        logger.info('Analytics stats reset');
      },
      undefined
    );
  }

  /**
   * Atomic read-modify-write against Redis with optimistic locking.
   * Falls back silently when Redis is unavailable (durable mirror already updated).
   */
  private async atomicUpdate(transform: (current: AnalyticsStats) => AnalyticsStats): Promise<void> {
    await redisService.safeExecute(
      async () => {
        const maxRetries = 5;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          await redisService.client.watch(STATS_KEY);
          try {
            const current = await this.getStatsFromRedis();
            const newStats = transform(current);
            const multi = redisService.client.multi();
            multi.setex(STATS_KEY, STATS_TTL_SECONDS, JSON.stringify(newStats));
            const execResult = await multi.exec();
            if (execResult !== null) {
              return; // Success
            }
            // null => concurrent modification, retry
          } finally {
            await redisService.client.unwatch().catch(() => {});
          }
        }
        logger.warn('Analytics atomic update failed after max retries');
      },
      undefined
    );
  }

  /**
   * Get stats directly from Redis (internal use).
   */
  private async getStatsFromRedis(): Promise<AnalyticsStats> {
    const raw = await redisService.client.get(STATS_KEY);
    // Base do read-modify-write: sem chave no Redis, parte do espelho durável.
    if (!raw) return this.snapshotStats();
    return safeParseStats(raw);
  }
}

export default new AnalyticsService(getDb());
