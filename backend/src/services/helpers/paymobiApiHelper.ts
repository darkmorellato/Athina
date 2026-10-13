import axios from 'axios';
import logger from '../../utils/logger.js';
import { maskDocument, maskName } from '../../utils/redact.js';

const SEARCH_URL = 'https://paymobi-fin-api.azurewebsites.net/sells/search';

/** Contrato retornado pela busca do Paymobi (apenas os campos usados). */
export interface PaymobiContract {
  id?: number | string;
  contrato?: string;
  customerName?: string;
  nickname?: string;
  cpf?: string;
  cnpj?: string;
  imei?: string;
  dataEfetivacao?: string;
  nextRenewalDate?: string;
  parcelas?: number | string;
  canceled?: boolean;
  completed?: boolean;
  [field: string]: unknown;
}

interface SearchResponse {
  result?: { data?: PaymobiContract[] };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function postSearch(token: string, body: Record<string, string>): Promise<PaymobiContract[]> {
  const response = await axios.post<SearchResponse>(SEARCH_URL, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });
  return response.data?.result?.data ?? [];
}

const onlyDigits = (value: unknown): string => String(value ?? '').replace(/\D/g, '');

export async function searchContracts(
  token: string,
  query: string,
  clientName?: string
): Promise<PaymobiContract[]> {
  const cleanQuery = onlyDigits(query);
  const isImei = cleanQuery.length === 15;
  const isCpf = cleanQuery.length === 11;

  if (isImei) {
    // LGPD: nunca logar o IMEI cru — só o formato mascarado.
    logger.info({ imei: maskDocument(cleanQuery) }, '[PaymobiScraperService] Searching by IMEI');
    return postSearch(token, { search: cleanQuery });
  }

  const nameToSearch = (clientName || query).trim();
  const words = nameToSearch.split(/\s+/).filter((w) => w.length > 2);
  const hasExactCpf = (list: PaymobiContract[]): boolean =>
    list.some((c) => onlyDigits(c.cpf) === cleanQuery);
  const needsFallback = (list: PaymobiContract[]): boolean =>
    list.length === 0 || (isCpf && !hasExactCpf(list));

  // Estratégia A: nome completo.
  logger.info({ name: maskName(nameToSearch) }, '[PaymobiScraperService] Attempting Strategy A: Exact Name');
  let contracts: PaymobiContract[] = [];
  try {
    contracts = await postSearch(token, { customerName: nameToSearch });
  } catch (err) {
    logger.warn({ error: errorMessage(err) }, '[PaymobiScraperService] Strategy A failed');
  }

  // Estratégia B: primeiras duas palavras do nome (fallback).
  if (needsFallback(contracts) && words.length >= 2) {
    const partialName = `${words[0]} ${words[1]}`;
    logger.info({ partialName: maskName(partialName) }, '[PaymobiScraperService] Attempting Strategy B: First Two Words');
    try {
      const partial = await postSearch(token, { customerName: partialName });
      if (partial.length > 0) contracts = partial;
    } catch (err) {
      logger.warn({ error: errorMessage(err) }, '[PaymobiScraperService] Strategy B failed');
    }
  }

  // Estratégia C: primeira palavra do nome (último recurso).
  if (needsFallback(contracts) && words.length >= 1) {
    const firstName = words[0];
    logger.info({ firstName: maskName(firstName) }, '[PaymobiScraperService] Attempting Strategy C: First Word');
    try {
      const partial = await postSearch(token, { customerName: firstName });
      if (partial.length > 0) contracts = partial;
    } catch (err) {
      logger.warn({ error: errorMessage(err) }, '[PaymobiScraperService] Strategy C failed');
    }
  }

  return contracts;
}
