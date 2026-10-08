/**
 * @fileoverview BullMQ Queue service for Paymobi scraping jobs.
 */
import { Queue, Worker } from 'bullmq';
import path from 'path';
import { fileURLToPath } from 'url';
import redisService from './RedisService.js';
import logger from '../utils/logger.js';
import type { PaymobiSearchParams } from '../types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const QUEUE_NAME = 'paymobi-scraper-jobs';

/**
 * BullMQ Queue service for Paymobi scraping jobs.
 * 
 * NOTE: This service is currently available but not actively used.
 * The SocketController makes direct calls to PaymobiScraperService for now.
 * This queue can be activated for high-throughput scenarios or background processing.
 */
class PaymobiQueueService {
  readonly queue: Queue;
  private worker: Worker | null = null;
  private initialized = false;

  constructor() {
    this.queue = new Queue(QUEUE_NAME, {
      connection: redisService.client,
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    });

    // Lazy initialization — only start worker when explicitly enabled
    if (process.env.ENABLE_PAYMOBI_QUEUE === 'true') {
      this.initWorker();
    }
  }

  private initWorker(): void {
    const isTs = __filename.endsWith('.ts') || __filename.includes('/src/') || __filename.includes('\\src\\');
    const workerPath = path.join(__dirname, `../workers/paymobiBullWorker.${isTs ? 'ts' : 'js'}`);

    this.worker = new Worker(
      QUEUE_NAME,
      workerPath,
      {
        connection: redisService.client,
        concurrency: 1,
      }
    );

    this.worker.on('completed', (job) => {
      logger.info({ jobId: job.id }, 'Paymobi scraper job completed');
    });

    this.worker.on('failed', (job, err) => {
      logger.error(
        { jobId: job?.id, error: err.message },
        'Paymobi scraper job failed'
      );
    });

    this.initialized = true;
    logger.info('Paymobi BullMQ worker initialized');
  }

  /**
   * Add a scraping job to the queue.
   * Ensures worker is initialized before adding jobs.
   */
  async addJob(data: PaymobiSearchParams): Promise<{ id: string | number }> {
    if (!this.initialized) {
      this.initWorker();
    }
    const job = await this.queue.add('scrape', data);
    logger.info({ jobId: job.id }, 'Paymobi job added to queue');
    if (!job.id) {
      throw new Error('Failed to generate Job ID');
    }
    return { id: job.id };
  }

  async getJobState(
    jobId: string | number
  ): Promise<import('bullmq').JobState | 'unknown'> {
    return this.queue.getJobState(jobId.toString());
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.worker?.close();
  }
}

export default new PaymobiQueueService();