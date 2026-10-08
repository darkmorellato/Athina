/// <reference lib="dom" />
/**
 * @fileoverview Puppeteer helper functions for Paymobi scraping.
 */
import type { Page } from 'puppeteer';

/** Typesafe delay utility */
export const wait = (ms: number): Promise<void> =>
  new Promise((res) => setTimeout(res, ms));

/**
 * Scroll element into view and focus, then clear input via keyboard
 * and type the new text with natural delay.
 */
export async function safeType(
  page: Page,
  selector: string,
  text: string
): Promise<void> {
  await page.waitForSelector(selector, { visible: true, timeout: 15000 });
  await page.evaluate(
    (sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollIntoView({ block: 'center' });
    },
    selector
  );
  await page.focus(selector);
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press('Backspace');

  if (text) {
    await page.type(selector, String(text), { delay: 30 });
  }
}

/**
 * Scroll element into view and click it using JS (avoids overlay issues).
 */
export async function safeClick(page: Page, selector: string): Promise<void> {
  await page.waitForSelector(selector, { visible: true, timeout: 15000 });
  await page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.click();
    }
  }, selector);
}

/**
 * Confirm any visible SweetAlert2 modal by clicking the confirm button.
 */
export async function confirmSweetAlert(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      const btn = document.querySelector<HTMLButtonElement>('.swal2-confirm');
      if (btn) btn.click();
    });
  } catch {
    // Silent - modal may not exist
  }
}

/**
 * Check whether the DataTable has any result rows.
 */
export async function checkHasResults(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const emptyText =
      document.querySelector('.dataTables_empty')?.textContent || '';
    const infoText =
      document.querySelector('#sells-table_info')?.textContent || '';

    const isEmpty =
      emptyText.includes('Nenhum') ||
      infoText.includes('Showing 0 to 0') ||
      infoText.includes('Mostrando 0 de 0');

    return !isEmpty && document.querySelectorAll('table tbody tr').length > 0;
  });
}