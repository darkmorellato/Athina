/**
 * @fileoverview Puppeteer launch arguments and event setup for WhatsApp.
 */
import type { Client } from 'whatsapp-web.js';
import logger from '../../utils/logger.js';

export const PUPPETEER_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--no-first-run', '--no-zygote', '--disable-gpu',
  '--disable-features=site-per-process',
  '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  '--disable-extensions', '--disable-component-update',
  '--disable-background-networking', '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows', '--disable-breakpad',
  '--disable-client-side-phishing-detection', '--disable-default-apps',
  '--disable-hang-monitor', '--disable-prompt-on-repost', '--disable-sync',
  '--disable-translate', '--metrics-recording-only', '--no-default-browser-check',
  '--safebrowsing-disable-auto-update',
] as const;

/** Setup all client event listeners */
export function setupClientEvents(
  client: Client,
  handlers: ClientEventHandlers
): void {
  const { onQR, onReady, onAuthenticated, onAuthFailure, onDisconnected, onLoading, onMessage } = handlers;

  client.on('qr', (qr: string) => {
    onQR(qr);
    logger.info('QR Code received');
  });

  client.on('ready', () => {
    onReady();
    logger.info('WhatsApp client ready');
  });

  client.on('authenticated', () => {
    onAuthenticated();
    logger.info('WhatsApp authenticated');
  });

  client.on('auth_failure', (msg: string) => {
    logger.error({ msg }, 'Auth failure');
    onAuthFailure?.();
  });

  client.on('disconnected', (reason: string) => {
    logger.warn({ reason }, 'WhatsApp disconnected');
    onDisconnected?.(reason);
  });

  client.on('loading_screen', (percent: number, message: string) => {
    onLoading?.(percent, message);
  });

  client.on('message_create', (msg: any) => {
    onMessage?.(msg);
  });
}

export interface ClientEventHandlers {
  onQR: (qr: string) => void;
  onReady: () => void;
  onAuthenticated: () => void;
  onAuthFailure?: () => void;
  onDisconnected?: (reason: string) => void;
  onLoading?: (percent: number, message: string) => void;
  onMessage?: (msg: any) => void;
}

/** Start automation to auto-click "Use here" button */
export function startUseHereAutomation(client: Client): ReturnType<typeof setInterval> {
  const interval: ReturnType<typeof setInterval> = setInterval(async () => {
    try {
      const pupPage = (client as unknown as { pupPage?: import('puppeteer').Page }).pupPage;
      if (!pupPage) return;

      const clicked = await pupPage.evaluate(() => {
        const doc = (globalThis as any).document;
        if (!doc) return false;
        const buttons = Array.from(doc.querySelectorAll('div[role="button"], button'));
        for (const btn of buttons) {
          const txt = (btn as any).textContent || '';
          if (txt.includes('Usar aqui') || txt.includes('Use here') || txt.includes('USAR AQUÍ')) {
            (btn as any).click();
            return true;
          }
        }
        return false;
      });

      if (clicked) {
        logger.info('[Automation] "Use here" button pressed!');
        // Objetivo cumprido — não manter o intervalo avaliando a página a
        // cada 2s para sempre (~43 mil evaluates/dia depois do READY).
        clearInterval(interval);
      }
    } catch {
      // Ignore errors during initial page load
    }
  }, 2000);
  return interval;
}