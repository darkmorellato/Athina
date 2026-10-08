/**
 * @fileoverview Redis client singleton with connection management and fallback.
 * Gracefully handles Redis unavailability.
 */
import Redis from 'ioredis';
import config from '../config/index.js';
import logger from '../utils/logger.js';

class RedisService {
  readonly client: Redis;
  private isConnected = false;

  constructor() {
    this.client = new Redis({
      host: config.redisHost,
      port: config.redisPort,
      maxRetriesPerRequest: 3,
      enableReadyCheck: false,
      retryStrategy(times: number): number | null {
        if (times > 10) {
          logger.warn('Redis: Max reconnection attempts reached. Running without cache.');
          return null; // Stop retrying
        }
        return Math.min(times * 100, 3000);
      },
      lazyConnect: true, // Don't connect immediately
    });

    this.client.on('connect', () => {
      this.isConnected = true;
      logger.info('Redis connected');
    });

    this.client.on('error', (err: Error) => {
      this.isConnected = false;
      // Only log first error, then suppress repeated errors
      if (err.message !== this.lastError) {
        logger.warn({ error: err.message }, 'Redis connection issue (will work without cache)');
        this.lastError = err.message;
      }
    });

    this.client.on('close', () => {
      this.isConnected = false;
    });

    // Try to connect, but don't block if Redis is unavailable
    this.client.connect().catch(() => {
      logger.warn('Redis: Initial connection failed. Running without cache.');
    });
  }

  private lastError = '';

  /** Check if Redis is available */
  isReady(): boolean {
    return this.isConnected;
  }

  /** Safely execute a Redis command with timeout */
  async safeExecute<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
    if (!this.isConnected) {
      return fallback;
    }
    try {
      const result = await Promise.race([
        operation(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Redis timeout')), 3000)
        ),
      ]);
      return result;
    } catch {
      return fallback;
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.client.quit();
      logger.info('Redis disconnected');
    } catch {
      // Ignore errors during shutdown
    }
  }
}

export default new RedisService();
