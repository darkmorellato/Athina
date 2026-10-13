/**
 * @fileoverview Analytics e estatísticas persistidas no SQLite.
 *
 * Os contadores ficam em memória e são espelhados no SQLite a cada alteração,
 * sobrevivendo a reinícios. Não contêm dados pessoais (apenas totais).
 */
import type { DatabaseSync } from 'node:sqlite';
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

const MAX_TRACKED_INTENTS = 100; // limita o crescimento do mapa de intenções

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

export class AnalyticsService {
  private db: DatabaseSync | null;
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

  private persist(sql: string, ...params: Array<string | number>): void {
    try {
      this.db?.prepare(sql).run(...params);
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Analytics persist failed');
    }
  }

  async getStats(): Promise<AnalyticsStats> {
    return { ...this.memoryStats, intentCounts: { ...this.memoryStats.intentCounts } };
  }

  /** Atualiza contadores com valores absolutos. */
  async updateStats(updates: Partial<AnalyticsStats>): Promise<void> {
    this.memoryStats = {
      ...this.memoryStats,
      ...updates,
      intentCounts: { ...this.memoryStats.intentCounts, ...(updates.intentCounts ?? {}) },
    };
    for (const key of NUMERIC_KEYS) {
      const val = updates[key];
      if (typeof val === 'number') {
        this.persist(
          'INSERT INTO analytics_stats (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          key,
          Math.max(0, Math.trunc(val))
        );
      }
    }
    if (updates.intentCounts) {
      for (const [intent, count] of Object.entries(updates.intentCounts)) {
        this.persist(
          'INSERT INTO analytics_intents (intent, count) VALUES (?, ?) ON CONFLICT(intent) DO UPDATE SET count = excluded.count',
          intent.slice(0, 100),
          Math.max(0, Math.trunc(count))
        );
      }
    }
  }

  /** Incrementa um contador numérico. */
  async increment(stat: keyof Omit<AnalyticsStats, 'intentCounts'>, amount = 1): Promise<void> {
    this.memoryStats[stat] = (this.memoryStats[stat] as number) + amount;
    this.persist(
      'INSERT INTO analytics_stats (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = analytics_stats.value + excluded.value',
      stat,
      Math.trunc(amount)
    );
  }

  /** Registra uma intenção (limitado a MAX_TRACKED_INTENTS categorias). */
  async trackIntent(intent: string): Promise<void> {
    const key = intent.slice(0, 100);
    if (
      this.memoryStats.intentCounts[key] !== undefined ||
      Object.keys(this.memoryStats.intentCounts).length < MAX_TRACKED_INTENTS
    ) {
      this.memoryStats.intentCounts[key] = (this.memoryStats.intentCounts[key] || 0) + 1;
      this.persist(
        'INSERT INTO analytics_intents (intent, count) VALUES (?, 1) ON CONFLICT(intent) DO UPDATE SET count = count + 1',
        key
      );
    }
  }

  async resetStats(): Promise<void> {
    this.memoryStats = { ...DEFAULT_STATS, intentCounts: {} };
    this.persist('DELETE FROM analytics_stats');
    this.persist('DELETE FROM analytics_intents');
  }
}

export default new AnalyticsService(getDb());
