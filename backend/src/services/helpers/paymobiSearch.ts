/// <reference lib="dom" />
/**
 * @fileoverview Login and navigation helpers for Paymobi scraping.
 * @deprecated This Puppeteer-based scraper is no longer used.
 * The PaymobiScraperService now uses direct API calls via paymobiApiHelper.ts.
 * This file is retained for reference only and can be safely removed.
 */
import type { Page } from 'puppeteer';
import { safeType, safeClick, confirmSweetAlert, wait, checkHasResults } from './paymobiActions.js';
import config from '../../config/index.js';
import logger from '../../utils/logger.js';

function cleanDigits(text: string): string {
  return text.replace(/\D/g, '');
}

function isCpfCnpj(value: string): boolean {
  return cleanDigits(value).length === 11 || cleanDigits(value).length === 14;
}

function isImei(value: string): boolean {
  return cleanDigits(value).length === 15;
}

/** Perform login to Paymobi portal */
export async function login(page: Page, email: string, password: string): Promise<void> {
  logger.info({ url: config.paymobiLoginUrl }, '[PaymobiScraperService] Logging in');
  await page.goto(config.paymobiLoginUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  await safeType(page, '#login-email', email);
  await safeType(page, '#login-password', password);
  await safeClick(page, '#sendButton');

  try {
    await page.waitForFunction(
      () => !window.location.href.includes('login_page.php'),
      { timeout: 20000 }
    );
    logger.info('[PaymobiScraperService] Login successful!');
  } catch {
    logger.warn('[PaymobiScraperService] Login redirect timeout, proceeding...');
  }
}

/** Perform search with automatic retry strategies */
export async function search(
  page: Page,
  query: string,
  clientName?: string,
  searchType?: string
): Promise<boolean> {
  const cleanQuery = cleanDigits(query);
  const byImei = searchType === 'imei' || isImei(cleanQuery);
  const byDoc = isCpfCnpj(cleanQuery);

  // Strategy 1: IMEI search
  if (byImei) {
    await doSearch(page, cleanQuery, '');
    if (await checkHasResults(page)) return true;
  }

  // Strategy 2: CPF/CNPJ search
  if (byDoc) {
    await doSearch(page, cleanQuery, clientName || '');
    if (await checkHasResults(page)) return true;
  }

  // Strategy 3: Client name search
  if (clientName) {
    await safeType(page, '#imeiContratoCpf', '');
    await safeType(page, '#filter-by-customer-name', clientName);
    await safeClick(page, '#search-button');
    await confirmSweetAlert(page);
    await wait(3000);
    if (await checkHasResults(page)) return true;
  }

  // Strategy 4: Generic query search (for names/numbers > 3 chars)
  if (!byDoc && cleanQuery.length > 3) {
    await safeType(page, '#imeiContratoCpf', '');
    await safeType(page, '#filter-by-customer-name', cleanQuery);
    await safeClick(page, '#search-button');
    await confirmSweetAlert(page);
    await wait(3000);
    return checkHasResults(page);
  }

  return false;
}

async function doSearch(page: Page, query: string, clientName: string): Promise<void> {
  await safeType(page, '#imeiContratoCpf', query);
  if (clientName) {
    await safeType(page, '#filter-by-customer-name', clientName);
  }
  await safeClick(page, '#search-button');
  await confirmSweetAlert(page);
  await wait(3000);
}