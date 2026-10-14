/// <reference lib="dom" />
/**
 * @fileoverview Direct API-based service for Paymobi sales portal with Cel.cash integration.
 */
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import axios from 'axios';
import { Mutex, Semaphore } from 'async-mutex';
import logger from '../utils/logger.js';
import { processPixPayment } from './helpers/paymobiPixProcessor.js';
import { searchContracts } from './helpers/paymobiApiHelper.js';
import type { PaymobiResult, ClientData } from '../types/index.js';
import type { PaymobiContract } from './helpers/paymobiApiHelper.js';

interface PaymobiInstallment {
  numberInstallment: number | string;
  dueDate: string;
  value: number | string;
  status: string;
  boletoLink?: string;
}

// Security fix: Shared browser instance with mutex to prevent race conditions
let sharedBrowser: Browser | null = null;
const browserMutex = new Mutex();
/** Limita a 3 abas simultâneas de extração PIX no Chromium para evitar exaustão de RAM sob carga. */
const pixPageSemaphore = new Semaphore(3);

/** Cache em memória do Bearer token do Paymobi (evita re-login a cada consulta). */
let cachedAuthToken: { email: string; token: string; expiresAt: number } | null = null;
const tokenMutex = new Mutex();
const TOKEN_TTL_MS = 45 * 60 * 1000;

export function clearPaymobiTokenCache(): void {
  cachedAuthToken = null;
}

async function getPaymobiToken(email: string, password: string, forceRefresh = false): Promise<string> {
  return tokenMutex.runExclusive(async () => {
    if (
      !forceRefresh &&
      cachedAuthToken &&
      cachedAuthToken.email === email &&
      cachedAuthToken.expiresAt > Date.now()
    ) {
      return cachedAuthToken.token;
    }
    const authBasic = Buffer.from(`${email}:${password}`).toString('base64');
    const loginResponse = await axios.get('https://paymobi-fin-api.azurewebsites.net/users/auth', {
      headers: {
        Authorization: `Basic ${authBasic}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });
    const token = loginResponse.data?.result?.token;
    if (!token) {
      throw new Error('Falha ao autenticar na API do Paymobi (Token não retornado)');
    }
    cachedAuthToken = {
      email,
      token,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    };
    return token;
  });
}

/** Extrai o PIX de um link de boleto respeitando o semáforo de concorrência (máx. 3 abas). */
export async function extractPixBounded(
  boletoLink: string
): Promise<{ pixCode: string; pixUrl: string; qrCodePath: string }> {
  if (!boletoLink) return { pixCode: '', pixUrl: '', qrCodePath: '' };
  const [, release] = await pixPageSemaphore.acquire();
  try {
    const browser = await getSharedBrowser();
    return await processPixPayment(browser, boletoLink);
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    logger.warn({ error: errMsg }, 'Failed to process PIX payment from boletoLink');
    return { pixCode: '', pixUrl: '', qrCodePath: '' };
  } finally {
    release();
  }
}

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
    /** Quando true, pula a abertura do Chromium no lookup inicial e deixa a extração do PIX sob demanda. */
    skipPix?: boolean;
  }): Promise<PaymobiResult> {
    // Security fix: Mask sensitive data (CPF/IMEI) in logs for LGPD compliance
    const maskedQuery = this.maskSensitiveData(params.query);
    logger.info({ query: maskedQuery, searchType: params.searchType, skipPix: Boolean(params.skipPix) }, '[PaymobiScraperService] Starting API-based query');

    if (!this.email || !this.password) {
      return { success: false, message: 'Credenciais do Paymobi não configuradas no servidor.' };
    }

    try {
      // 1. Authenticate with Paymobi API (cached Bearer token, refresh on 401)
      let token = await getPaymobiToken(this.email, this.password);

      // 2. Search for the contract using the Token
      const cleanQuery = params.query.replace(/\D/g, ''); // strip non-numeric for cpf/imei
      const isImei = cleanQuery.length === 15;
      const isCpf = cleanQuery.length === 11;
      const isCnpj = cleanQuery.length === 14;

      let contracts: PaymobiContract[];
      try {
        contracts = await searchContracts(token, params.query, params.clientName);
      } catch (searchErr) {
        if (axios.isAxiosError(searchErr) && searchErr.response?.status === 401) {
          token = await getPaymobiToken(this.email, this.password, true);
          contracts = await searchContracts(token, params.query, params.clientName);
        } else {
          throw searchErr;
        }
      }

      if (!contracts || !Array.isArray(contracts) || contracts.length === 0) {
        return { success: false, reason: 'NOT_FOUND', message: NOT_FOUND_MSG };
      }

      // 3. Enforce strict exact match if the search was by CPF or IMEI
      let matchedContracts = contracts;
      if (isCpf) {
        matchedContracts = contracts.filter((c: PaymobiContract) => {
          const cCpf = String(c.cpf || '').replace(/\D/g, '');
          return cCpf === cleanQuery;
        });
      } else if (isImei) {
        matchedContracts = contracts.filter((c: PaymobiContract) => {
          const cImei = String(c.imei || '').replace(/\D/g, '');
          return cImei === cleanQuery;
        });
      } else if (isCnpj) {
        // Match exato de CNPJ: sem isto a busca por nome podia devolver
        // contrato de OUTRO titular e o fluxo selecionava o primeiro ativo.
        matchedContracts = contracts.filter((c: { cnpj?: unknown }) => {
          const cCnpj = String(c.cnpj || '').replace(/\D/g, '');
          return cCnpj === cleanQuery;
        });
      }

      if (matchedContracts.length === 0) {
        return { success: false, reason: 'NOT_FOUND', message: NOT_FOUND_MSG };
      }

      // Filter active contracts (not canceled and not completed)
      const activeContracts = matchedContracts.filter((c: PaymobiContract) => !c.canceled && !c.completed);
      if (activeContracts.length === 0) {
        const completedContract = matchedContracts.find((c: PaymobiContract) => c.completed);
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
        dataVenda: selected.dataEfetivacao ?? '',
        expirationDate: selected.nextRenewalDate ?? '',
        duration: `${selected.parcelas} meses`,
        cpf: selected.cpf ?? '',
        contrato: selected.contrato || String(selected.id),
        nome: selected.customerName || 'Cliente Paymobi',
        imei: selected.imei ?? '',
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
      const installments: PaymobiInstallment[] = installmentsData?.installments || [];

      const formatInstallmentDate = (dueDate: unknown): string => {
        const dStr = String(dueDate);
        const match = dStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (match) return `${match[3]}/${match[2]}/${match[1]}`;
        return new Date(dStr as string).toLocaleDateString('pt-BR');
      };
      const formatInstallmentValue = (value: unknown): string =>
        new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value) || 0);

      // Lista completa (pagas e pendentes) — usada no "Verificar Saldo".
      const installmentSummaries = installments.map((inst) => ({
        numero: String(inst.numberInstallment),
        vencimento: formatInstallmentDate(inst.dueDate),
        valor: formatInstallmentValue(inst.value),
        status: inst.status === 'paid' ? 'Pago' : new Date(inst.dueDate) < new Date() ? 'Em atraso' : 'Aberta',
      }));

      // Quantidade de parcelas em atraso (não pagas e já vencidas) — distingue
      // "amarelo" (1 atraso, self-service) de "vermelho" (2+, vai para humano).
      const overdueCount = installments.filter(
        (inst) => inst.status !== 'paid' && new Date(inst.dueDate) < new Date()
      ).length;

      // Find the first unpaid installment
      const openInstallment = installments.find((inst) => inst.status !== 'paid');

      if (!openInstallment) {
        return {
          success: true,
          message: 'Parabéns! Você está em dia com todas as parcelas!',
          data: {
            client: clientData,
            statusContrato: 'em_dia',
            overdueCount: 0,
            installments: installmentSummaries,
          },
        };
      }

      // 5. Process PIX code using bounded semaphore (unless skipPix is requested for fast initial lookup)
      let pix = { pixCode: '', pixUrl: '', qrCodePath: '' };
      if (openInstallment.boletoLink && !params.skipPix) {
        logger.info('[PaymobiScraperService] Processing PIX for open installment');
        pix = await extractPixBounded(openInstallment.boletoLink);
      }

      const isAtrasado = new Date(openInstallment.dueDate) < new Date();

      return {
        success: true,
        message: 'Boleto/PIX localizado e processado com sucesso.',
        data: {
          client: clientData,
          statusContrato: isAtrasado ? 'atraso' : 'em_dia',
          overdueCount,
          installments: installmentSummaries,
          parcela: {
            numero: String(openInstallment.numberInstallment),
            vencimento: formatInstallmentDate(openInstallment.dueDate),
            valor: formatInstallmentValue(openInstallment.value),
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