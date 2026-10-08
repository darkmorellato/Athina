/// <reference lib="dom" />
/**
 * @fileoverview Data extraction helpers for Paymobi scraper.
 * @deprecated This Puppeteer-based extraction is no longer used.
 * The PaymobiScraperService now uses direct API calls via paymobiApiHelper.ts.
 * This file is retained for reference only and can be safely removed.
 */
import type { Page } from 'puppeteer';
import type { Contract, Parcela } from '../../types/index.js';

export interface ExtractedContracts {
  contracts: Contract[];
  selectedContract: Contract | null;
}

export interface ExtractedParcelas {
  parcelas: Parcela[];
  openParcela: Parcela | null;
  isAtrasado: boolean;
}

/** Extract all contracts from results table */
export async function extractContracts(page: Page): Promise<Contract[]> {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    return rows
      .map((row, index) => {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 10) return null;
        return {
          index,
          loja: cells[0]?.textContent?.trim() || '',
          dataVenda: cells[1]?.textContent?.trim() || '',
          expirationDate: cells[2]?.textContent?.trim() || '',
          duration: cells[3]?.textContent?.trim() || '',
          statusLicenca: cells[4]?.textContent?.trim() || '',
          contrato: cells[5]?.textContent?.trim() || '',
          nome: cells[6]?.textContent?.trim() || '',
          imei: cells[7]?.textContent?.trim() || '',
          statusVenda: cells[9]?.textContent?.trim() || '',
        };
      })
      .filter((c): c is Contract => c !== null);
  });
}

/** Extract all parcels from SweetAlert modal */
export async function extractParcelas(page: Page): Promise<Parcela[]> {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.swal2-modal table tbody tr'));
    return rows
      .map((row) => {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 8) return null;
        return {
          numero: cells[0]?.textContent?.trim() || '',
          vencimento: cells[1]?.textContent?.trim() || '',
          valor: cells[2]?.textContent?.trim() || '',
          valorPago: cells[3]?.textContent?.trim() || '',
          status: cells[4]?.textContent?.trim() || '',
          dataPagamento: cells[6]?.textContent?.trim() || '',
          boletoUrl: cells[7]?.querySelector('a')?.href || null,
        };
      })
      .filter((p): p is Parcela => p !== null);
  });
}

/** Find first open/overdue parcela with valid boleto URL */
export function findOpenParcela(parcelas: Parcela[]): Parcela | null {
  return (
    parcelas.find((p) => {
      const s = p.status.toLowerCase();
      return (
        (s.includes('atraso') ||
          s.includes('pendente') ||
          s.includes('aberto') ||
          !s.includes('pago')) &&
        Boolean(p.boletoUrl)
      );
    }) ?? null
  );
}

/** Filter active contracts (not finalized) */
export function filterActiveContracts(contracts: Contract[]): Contract[] {
  return contracts.filter((c) =>
    /em uso|vigencia|vigência/i.test(c.statusLicenca)
  );
}