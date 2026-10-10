/**
 * @fileoverview Redis client singleton with connection management and fallback.
 * Gracefully handles Redis unavailability.
 *
 * Política de reconexão (24/7): o ioredis tenta ~4 vezes por ciclo (backoff
 * até 3s) e desiste; um watchdog com timer UNREF'd recria o cliente a cada
 * 60s enquanto o Redis estiver fora. Assim:
 *  - o serviço religa sozinho quando o Redis volta (antes: desistia após 10
 *    tentativas e ficava em fallback de memória até restart do processo);
 *  - scripts/testes NÃO ficam presos — timers unref'd não seguram o event
 *    loop quando não há mais trabalho (retry infinito segurava: travava o
 *    `npm test` com o Redis desligado).
 */
import Redis from 'ioredis';
import config from '../config/index.js';
import logger from '../utils/logger.js';

class RedisService {
  private _client: Redis;
  private isConnected = false;
  private lastError = '';
  private reattachTimer: ReturnType<typeof setInterval> | null = null;
  private readonly options = {
    host: config.redisHost,
    port: config.redisPort,
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    retryStrategy(times: number): number | null {
      if (times > 4) return null; // fim do ciclo; watchdog re-arma com cliente novo
      return Math.min(times * 200, 3000);
    },
    lazyConnect: true, // Don't connect immediately
  };

  constructor() {
    this._client = this.createClient();

    // Watchdog de reconexão: recria o cliente se o ioredis desistiu ('end').
    // UNREF'd de propósito — em produção mantém a reconexão viva, mas não
    // impede scripts curtos de terminar.
    this.reattachTimer = setInterval(() => this.maybeReattach(), 60_000);
    this.reattachTimer.unref();
  }

  /** Cliente atual (pode ser recriado pelo watchdog — sempre use o getter). */
  get client(): Redis {
    return this._client;
  }

  private createClient(): Redis {
    const client = new Redis(this.options);

    client.on('connect', () => {
      this.isConnected = true;
      logger.info('Redis connected');
    });

    client.on('error', (err: Error) => {
      this.isConnected = false;
      // Only log first error, then suppress repeated errors
      if (err.message !== this.lastError) {
        logger.warn({ error: err.message }, 'Redis connection issue (will work without cache)');
        this.lastError = err.message;
      }
    });

    client.on('close', () => {
      this.isConnected = false;
    });

    // Try to connect, but don't block if Redis is unavailable
    client.connect().catch(() => {
      logger.warn('Redis: Initial connection failed. Running without cache.');
    });

    return client;
  }

  /** Se o cliente morreu de vez ('end'), cria um novo e tenta outra vez. */
  private maybeReattach(): void {
    if (this.isConnected) return;
    // 'connecting'/'reconnecting'/'wait': o próprio ioredis está tentando.
    if (this._client.status !== 'end') return;
    try {
      this._client.removeAllListeners();
      this._client.disconnect();
    } catch {
      // ignore
    }
    this._client = this.createClient();
    logger.info('Redis: cliente recriado — nova tentativa de conexão');
  }

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
    if (this.reattachTimer) {
      clearInterval(this.reattachTimer);
      this.reattachTimer = null;
    }
    try {
      await this._client.quit();
      logger.info('Redis disconnected');
    } catch {
      // Ignore errors during shutdown
    }
  }
}

export default new RedisService();
