/**
 * @fileoverview Worker thread logic for Paymobi scraping using worker_threads.
 * @deprecated This worker_threads-based approach is no longer used.
 * The system now uses BullMQ via paymobiBullWorker.ts for job processing,
 * or direct API calls via PaymobiScraperService.
 * This file is retained for reference only and can be safely removed.
 */
import { parentPort } from 'worker_threads';
import { PaymobiScraperService } from '../services/PaymobiScraperService.js';
import logger from '../utils/logger.js';

interface WorkerPayload {
  email: string;
  password: string;
  query: string;
  clientName?: string;
  searchType?: string;
}

parentPort?.on('message', async (payload: WorkerPayload) => {
  const { email, password, query, clientName, searchType } = payload;

  logger.info(`[PaymobiWorker] Starting scrape for query: ${query}`);

  try {
    const scraper = new PaymobiScraperService(email, password);
    const result = await scraper.scrape({ query, clientName, searchType });
    parentPort?.postMessage({ success: true, result });
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      '[PaymobiWorker] Scrape failed'
    );
    parentPort?.postMessage({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});