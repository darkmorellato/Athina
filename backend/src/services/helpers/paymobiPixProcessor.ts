/// <reference lib="dom" />
/**
 * @fileoverview PIX extraction and processing from boleto URLs.
 */
import type { Browser, Page } from 'playwright';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import logger from '../../utils/logger.js';

export interface PixResult {
  pixUrl: string;
  pixCode: string;
  qrCodePath: string;
}

/** Extract PIX URL from PDF response by following redirects */
export async function extractPixUrlFromPdf(boletoUrl: string): Promise<string> {
  let finalUrl = boletoUrl;

  try {
    const response = await axios.get(boletoUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
    });

    const binaryText = response.data.toString('binary');
    const shortMatch = binaryText.match(
      /https:\/\/cel\.cash\/qb\/[0-9]+\/[0-9]+/
    );

    if (shortMatch) {
      const shortUrl = shortMatch[0];
      const redirectRes = await axios.get(shortUrl, {
        maxRedirects: 5,
        timeout: 10000,
        validateStatus: () => true,
      });

      finalUrl =
        (redirectRes.request as any)?.res?.responseUrl ||
        shortUrl;
    }
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      'Error extracting PIX URL from PDF'
    );
  }

  return finalUrl;
}

/** Extract PIX copy-paste code from payment page */
export async function extractPixCode(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const elements = Array.from(
      document.querySelectorAll('input, textarea, p, span, div, code')
    );
    for (const el of elements) {
      const val = ((el as HTMLInputElement).value || el.textContent || '').trim();
      if (val.startsWith('000201')) return val;
    }
    return null;
  });
}

/** Scrape CPF from payment page */
export async function extractCpfFromPage(page: Page): Promise<string> {
  return page.evaluate(() => {
    const text = document.body.textContent || '';
    return (
      text.match(/\*\*\*\.\d{3}\.\d{3}-\*\*/)?.[0] ??
      text.match(/\d{3}\.\d{3}\.\d{3}-\d{2}/)?.[0] ??
      ''
    );
  });
}

/** Process PIX from boleto: navigate to page and extract code */
export async function processPixPayment(
  browser: Browser,
  boletoUrl: string
): Promise<PixResult> {
  let finalPixUrl = await extractPixUrlFromPdf(boletoUrl);
  let pixCopiaCola: string | null = null;

  const payPage = await browser.newPage();
  await payPage.setViewportSize({ width: 800, height: 1200 });

  try {
    try {
      logger.info(
        { url: finalPixUrl },
        '[PaymobiScraperService] Opening PIX payment page'
      );
      await payPage.goto(finalPixUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      // Equivalente ao antigo networkidle2 (best-effort — a página de
      // pagamento pode manter conexões abertas e nunca "ficar ociosa").
      await payPage
        .waitForLoadState('networkidle', { timeout: 15000 })
        .catch(() => undefined);

      await new Promise((res) => setTimeout(res, 3000));
      pixCopiaCola = await extractPixCode(payPage);

      const scrapedCpf = await extractCpfFromPage(payPage);
      if (scrapedCpf) {
        logger.info({ cpf: scrapedCpf }, 'CPF scraped from PIX page');
      }
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        '[PaymobiScraperService] Error processing PIX payment page'
      );
    }

    // Screenshot for debugging
    const debugDir = path.join(process.cwd(), 'debug');
    if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
    const qrCodePath = path.join(debugDir, `qrcode_${Date.now()}.png`);

    try {
      await payPage.screenshot({ path: qrCodePath });
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'Failed to screenshot payment page'
      );
    }

    return {
      pixUrl: finalPixUrl,
      pixCode: pixCopiaCola || 'Abra o link do boleto para obter o PIX Copia e Cola',
      qrCodePath,
    };
  } finally {
    try {
      await payPage.close();
    } catch (closeErr) {
      logger.warn(
        { error: closeErr instanceof Error ? closeErr.message : String(closeErr) },
        'Failed to close PIX payPage'
      );
    }
  }
}