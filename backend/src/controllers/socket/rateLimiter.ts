import logger from '../../utils/logger.js';

class RateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly clients = new Map<string, number[]>();

  constructor(windowMs: number, maxRequests: number) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  isAllowed(socketId: string): boolean {
    const now = Date.now();
    const timestamps = this.clients.get(socketId) ?? [];
    const recent = timestamps.filter((t) => now - t < this.windowMs);

    if (recent.length >= this.maxRequests) {
      return false;
    }

    recent.push(now);
    this.clients.set(socketId, recent);
    return true;
  }

  cleanup(socketId: string): void {
    this.clients.delete(socketId);
  }

  /** Security fix: Remove stale entries to prevent unbounded memory growth */
  cleanupStale(): void {
    const now = Date.now();
    for (const [socketId, timestamps] of this.clients.entries()) {
      const recent = timestamps.filter((t) => now - t < this.windowMs);
      if (recent.length === 0) {
        this.clients.delete(socketId);
      } else {
        this.clients.set(socketId, recent);
      }
    }
  }

  get size(): number {
    return this.clients.size;
  }
}

const aiRateLimiter = new RateLimiter(60_000, 30);
const ttsRateLimiter = new RateLimiter(60_000, 10);
const paymobiRateLimiter = new RateLimiter(60_000, 10);
const avatarRateLimiter = new RateLimiter(60_000, 30);

// Security fix: Periodic cleanup of stale rate limiter entries (every 5 minutes)
const rateLimiterCleanupInterval = setInterval(() => {
  aiRateLimiter.cleanupStale();
  ttsRateLimiter.cleanupStale();
  paymobiRateLimiter.cleanupStale();
  logger.debug(
    { ai: aiRateLimiter.size, tts: ttsRateLimiter.size, paymobi: paymobiRateLimiter.size },
    'Rate limiters cleaned up'
  );
}, 300_000);
rateLimiterCleanupInterval.unref();

export { aiRateLimiter, ttsRateLimiter, paymobiRateLimiter, avatarRateLimiter };
