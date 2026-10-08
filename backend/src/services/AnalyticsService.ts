/**
 * @fileoverview Analytics and statistics service with Redis fallback.
 * Works without Redis using in-memory storage.
 * Security fixes: atomic increments (WATCH/MULTI/EXEC), bounded intents, safe JSON parsing.
 */
import redisService from './RedisService.js';
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

// In-memory fallback when Redis is unavailable
let memoryStats: AnalyticsStats = { ...DEFAULT_STATS, intentCounts: {} };

class AnalyticsService {
  /**
   * Get current analytics stats.
   */
  async getStats(): Promise<AnalyticsStats> {
    return redisService.safeExecute(
      async () => {
        const raw = await redisService.client.get(STATS_KEY);
        if (!raw) return { ...DEFAULT_STATS };
        return safeParseStats(raw);
      },
      { ...memoryStats, intentCounts: { ...memoryStats.intentCounts } } // Fallback to memory
    );
  }

  /**
   * Update stats with partial data.
   * Security fix: atomic read-modify-write using WATCH/MULTI/EXEC with retries.
   */
  async updateStats(updates: Partial<AnalyticsStats>): Promise<void> {
    // Always update memory fallback
    memoryStats = {
      ...memoryStats,
      ...updates,
      intentCounts: {
        ...memoryStats.intentCounts,
        ...(updates.intentCounts ?? {}),
      },
    };

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

  /**
   * Increment a specific stat counter.
   * Security fix: atomic via WATCH/MULTI/EXEC.
   */
  async increment(stat: keyof Omit<AnalyticsStats, 'intentCounts'>, amount = 1): Promise<void> {
    // Update memory
    memoryStats[stat] = (memoryStats[stat] as number) + amount;

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

    // Update memory with intent limit
    if (
      memoryStats.intentCounts[key] !== undefined ||
      Object.keys(memoryStats.intentCounts).length < MAX_TRACKED_INTENTS
    ) {
      memoryStats.intentCounts[key] = (memoryStats.intentCounts[key] || 0) + 1;
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
   * Reset all stats.
   */
  async resetStats(): Promise<void> {
    memoryStats = { ...DEFAULT_STATS, intentCounts: {} };

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
   * Falls back silently when Redis is unavailable (memory already updated).
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
    if (!raw) return { ...DEFAULT_STATS };
    return safeParseStats(raw);
  }
}

export default new AnalyticsService();
