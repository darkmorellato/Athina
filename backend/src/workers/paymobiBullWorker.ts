/**
 * @fileoverview BullMQ worker processor for Paymobi scraping jobs.
 */
import { Worker } from 'bullmq';
import { PaymobiScraperService } from '../services/PaymobiScraperService.js';
import redisService from '../services/RedisService.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import type { PaymobiSearchParams, PaymobiResult } from '../types/index.js';

const worker = new Worker<PaymobiSearchParams>(
  'paymobi-scraper-jobs',
  async (job) => {
    const { query, clientName, searchType } = job.data;
    logger.info({ jobId: job.id, query }, 'Processing Paymobi scraper job');

    const scraper = new PaymobiScraperService(
      config.paymobiEmail ?? '',
      config.paymobiPassword ?? ''
    );

    const result = await scraper.scrape({ query, clientName, searchType });
    return result as PaymobiResult;
  },
  {
    connection: redisService.client,
    concurrency: 1,
  }
);

worker.on('completed', (job) => {
  logger.info({ jobId: job.id }, 'BullMQ Paymobi worker job completed');
});

worker.on('failed', (job, err) => {
  logger.error(
    { jobId: job?.id, error: err.message },
    'BullMQ Paymobi worker job failed'
  );
});

export default worker;