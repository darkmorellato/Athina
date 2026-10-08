/// <reference lib="dom" />
/**
 * @fileoverview Direct API-based service for Paymobi sales portal with Cel.cash integration.
 */
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import axios from 'axios';
import { Mutex } from 'async-mutex';
import logger from '../utils/logger.js';
import { processPixPayment } from './helpers/paymobiPixProcessor.js';
import { searchContracts } from './helpers/paymobiApiHelper.js';
import type { PaymobiResult, ClientData } from '../types/index.js';

// Security fix: Shared browser instance with mutex to prevent race conditions
let sharedBrowser: Browser | null = null;
const browserMutex = new Mutex();

async function getSharedBrowser(): Promise<Browser> {
  return await browserMutex.runExclusive(async () => {
    if (sharedBrowser && sharedBrowser.isConnected()) {
      return sharedBrowser;
    }
    sharedBrowser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    logger.info('Shared browser instance created (Playwright chromium)');
    return sharedBrowser;
  });
}

/** Safely close the shared browser instance */
export async function closeSharedBrowser(): Promise<void> {
  await browserMutex.runExclusive(async () => {
    if (sharedBrowser) {
      try {
        await sharedBrowser.close();
        logger.info('Shared browser instance closed');
      } catch (error) {
        logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Failed to close shared browser');
      } finally {
        sharedBrowser = null;
      }
    }
  });
}

const NOT_FOUND_MSG =
  'Infelizmente não encontramos nenhum cadastro com os dados fornecidos. 🔍\n\n' +
  'Por favor, verifique se digitou o CPF/CNPJ corretamente. Caso não encontre, envie o IMEI do aparelho para localizarmos seu contrato! 📲\n\n' +
  'Somos da Financeira Nuovo, não confunda com nossas concorrentes... 🔵';

const FINALIZED_MSG =
  'Encontramos seu cadastro, pois ja foi nosso cliente. Mas seu contrato conosco se encontra Quitado. Algo que eu possa te ajudar?';

export class PaymobiScraperService {
  constructor(private email: string, private password: string) {}

  /**
   * Security fix: Mask sensitive PII (CPF/CNPJ/IMEI) for LGPD compliance in logs.
   * CPF: 123.456.789-00 -> 123.***.***-**
   * IMEI: 123456789012345 -> 123***********5
   */
  private maskSensitiveData(data: string): string {
    if (!data) return '';
    
    let masked = data;
    
    // Mask CPF (formatted): 123.456.789-00 -> 123.***.***-**
    masked = masked.replace(/(\d{3})\.(\d{3})\.(\d{3})-(\d{2})/g, '$1.***.***-**');
    
    // Mask CNPJ (formatted): 12.345.678/0001-90 -> 12.***.***/****-**
    masked = masked.replace(/(\d{2})\.(\d{3})\.(\d{3})\/(\d{4})-(\d{2})/g, '$1.***.***/****-**');
    
    // Mask IMEI (15 digits): keep first 3 and last 2
    masked = masked.replace(/\b(\d{3})(\d{10})(\d{2})\b/g, '$1**********$3');
    
    // Mask raw CPF (11 digits): keep first 3 and last 2
    masked = masked.replace(/\b(\d{3})(\d{6})(\d{2})\b/g, '$1******$3');
    
    return masked;
  }

  async scrape(params: {
    query: string;
    clientName?: string;
    searchType?: string;
  }): Promise<PaymobiResult> {
    // Security fix: Mask sensitive data (CPF/IMEI) in logs for LGPD compliance
    const maskedQuery = this.maskSensitiveData(params.query);
    logger.info({ query: maskedQuery, searchType: params.searchType }, '[PaymobiScraperService] Starting API-based query');

    if (!this.email || !this.password) {
      return { success: false, message: 'Credenciais do Paymobi não configuradas no servidor.' };
    }

    try {
      // 1. Authenticate with Paymobi API using Basic Auth to obtain Session Token
      const authBasic = Buffer.from(`${this.email}:${this.password}`).toString('base64');
      const loginResponse = await axios.get('https://paymobi-fin-api.azurewebsites.net/users/auth', {
        headers: {
          'Authorization': `Basic ${authBasic}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      const token = loginResponse.data?.result?.token;
      if (!token) {
        throw new Error('Falha ao autenticar na API do Paymobi (Token não retornado)');
      }

      // 2. Search for the contract using the Token
      const cleanQuery = params.query.replace(/\D/g, ''); // strip non-numeric for cpf/imei
      const isImei = cleanQuery.length === 15;
      const isCpf = cleanQuery.length === 11;

      const contracts = await searchContracts(token, params.query, params.clientName);

      if (!contracts || !Array.isArray(contracts) || contracts.length === 0) {
        return { success: false, reason: 'NOT_FOUND', message: NOT_FOUND_MSG };
      }

      // 3. Enforce strict exact match if the search was by CPF or IMEI
      let matchedContracts = contracts;
      if (isCpf) {
        matchedContracts = contracts.filter((c: any) => {
          const cCpf = String(c.cpf || '').replace(/\D/g, '');
          return cCpf === cleanQuery;
        });
      } else if (isImei) {
        matchedContracts = contracts.filter((c: any) => {
          const cImei = String(c.imei || '').replace(/\D/g, '');
          return cImei === cleanQuery;
        });
      }

      if (matchedContracts.length === 0) {
        return { success: false, reason: 'NOT_FOUND', message: NOT_FOUND_MSG };
      }

      // Filter active contracts (not canceled and not completed)
      const activeContracts = matchedContracts.filter((c: any) => !c.canceled && !c.completed);
      if (activeContracts.length === 0) {
        const completedContract = matchedContracts.find((c: any) => c.completed);
        if (completedContract) {
          return { success: false, reason: 'CONTRACT_FINALIZED', message: FINALIZED_MSG };
        }
        return { success: false, reason: 'NOT_FOUND', message: NOT_FOUND_MSG };
      }

      // Select first active contract
      const selected = activeContracts[0];

      // Format client data to match frontend requirements
      const clientData: ClientData = {
        loja: selected.nickname || 'Loja Paymobi',
        dataVenda: selected.dataEfetivacao,
        expirationDate: selected.nextRenewalDate,
        duration: `${selected.parcelas} meses`,
        cpf: selected.cpf,
        contrato: selected.contrato || String(selected.id),
        nome: selected.customerName || 'Cliente Paymobi',
        imei: selected.imei,
        statusVenda: selected.completed ? 'completed' : 'active',
      };

      // 4. Fetch installments for the selected contract ID
      const installmentsResponse = await axios.get(`https://paymobi-fin-api.azurewebsites.net/installments/${selected.id}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        },
        timeout: 15000
      });

      const installmentsData = installmentsResponse.data?.result;
      const installments = installmentsData?.installments || [];

      // Find the first unpaid installment
      const openInstallment = installments.find((inst: any) => inst.status !== 'paid');

      if (!openInstallment) {
        return {
          success: true,
          message: 'Parabéns! Você está em dia com todas as parcelas!',
          data: { client: clientData, statusContrato: 'em_dia' }
        };
      }

      // 5. Process PIX code using shared browser instance (avoids launching new browser per request)
      let pix = { pixCode: '', pixUrl: '', qrCodePath: '' };
      if (openInstallment.boletoLink) {
        logger.info({ url: openInstallment.boletoLink }, '[PaymobiScraperService] Processing PIX for open installment');
        try {
          const browser = await getSharedBrowser();
          pix = await processPixPayment(browser, openInstallment.boletoLink);
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          logger.warn({ error: errMsg }, 'Failed to process PIX payment from boletoLink');
          // Security fix: Properly close browser before resetting to prevent zombie Chromium processes
          await closeSharedBrowser().catch((closeErr) => {
            logger.error({ error: closeErr instanceof Error ? closeErr.message : String(closeErr) }, 'Failed to close browser during error recovery');
          });
        }
      }

      const isAtrasado = new Date(openInstallment.dueDate) < new Date();

      // Format values to currency string
      const formattedValue = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(openInstallment.value);

      return {
        success: true,
        message: 'Boleto/PIX localizado e processado com sucesso.',
        data: {
          client: clientData,
          statusContrato: isAtrasado ? 'atraso' : 'em_dia',
          parcela: {
            numero: String(openInstallment.numberInstallment),
            vencimento: (() => {
              const dStr = String(openInstallment.dueDate);
              const match = dStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
              if (match) {
                return `${match[3]}/${match[2]}/${match[1]}`;
              }
              return new Date(openInstallment.dueDate).toLocaleDateString('pt-BR');
            })(),
            valor: formattedValue,
            status: openInstallment.status === 'pending' ? 'Aberta' : openInstallment.status,
            boletoUrl: openInstallment.boletoLink || '',
            ...pix,
            total: installments.length,
          },
        },
      };

    } catch (error) {
      const errorMsg = axios.isAxiosError(error)
        ? (error.response?.data?.message ?? error.message)
        : error instanceof Error
          ? error.message
          : String(error);
      logger.error({ error: errorMsg }, '[PaymobiScraperService] API query failed');
      return { success: false, message: `Erro ao buscar cadastro: ${errorMsg}` };
    }
  }
}

export default PaymobiScraperService;