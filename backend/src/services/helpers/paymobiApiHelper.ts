import axios from 'axios';
import logger from '../../utils/logger.js';
import { maskDocument, maskName } from '../../utils/redact.js';

export async function searchContracts(token: string, query: string, clientName?: string): Promise<any[]> {
  const cleanQuery = query.replace(/\D/g, ''); // strip non-numeric for cpf/imei
  const isImei = cleanQuery.length === 15;
  const isCpf = cleanQuery.length === 11;

  let contracts: any[] = [];

  if (isImei) {
    // LGPD: nunca logar o IMEI cru — só o formato mascarado.
    logger.info({ imei: maskDocument(cleanQuery) }, '[PaymobiScraperService] Searching by IMEI');
    const searchResponse = await axios.post('https://paymobi-fin-api.azurewebsites.net/sells/search', {
      search: cleanQuery
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
    contracts = searchResponse.data?.result?.data || [];
  } else {
    const nameToSearch = (clientName || query).trim();

    // Strategy A: Exact Name/Full Name
    logger.info({ name: maskName(nameToSearch) }, '[PaymobiScraperService] Attempting Strategy A: Exact Name');
    try {
      const response = await axios.post('https://paymobi-fin-api.azurewebsites.net/sells/search', {
        customerName: nameToSearch
      }, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      });
      contracts = response.data?.result?.data || [];
    } catch (e: any) {
      logger.warn({ error: e.message }, '[PaymobiScraperService] Strategy A failed');
    }

    // Strategy B: First two words of name (fallback)
    if (contracts.length === 0 || (isCpf && !contracts.some((c: any) => String(c.cpf || '').replace(/\D/g, '') === cleanQuery))) {
      const words = nameToSearch.split(/\s+/).filter(w => w.length > 2);
      if (words.length >= 2) {
        const partialName = `${words[0]} ${words[1]}`;
        logger.info({ partialName: maskName(partialName) }, '[PaymobiScraperService] Attempting Strategy B: First Two Words');
        try {
          const response = await axios.post('https://paymobi-fin-api.azurewebsites.net/sells/search', {
            customerName: partialName
          }, {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            timeout: 15000
          });
          const partialContracts = response.data?.result?.data || [];
          if (partialContracts.length > 0) {
            contracts = partialContracts;
          }
        } catch (e: any) {
          logger.warn({ error: e.message }, '[PaymobiScraperService] Strategy B failed');
        }
      }
    }

    // Strategy C: First word of name (final fallback)
    if (contracts.length === 0 || (isCpf && !contracts.some((c: any) => String(c.cpf || '').replace(/\D/g, '') === cleanQuery))) {
      const words = nameToSearch.split(/\s+/).filter(w => w.length > 2);
      if (words.length >= 1) {
        const firstName = words[0];
        logger.info({ firstName: maskName(firstName) }, '[PaymobiScraperService] Attempting Strategy C: First Word');
        try {
          const response = await axios.post('https://paymobi-fin-api.azurewebsites.net/sells/search', {
            customerName: firstName
          }, {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            timeout: 15000
          });
          const partialContracts = response.data?.result?.data || [];
          if (partialContracts.length > 0) {
            contracts = partialContracts;
          }
        } catch (e: any) {
          logger.warn({ error: e.message }, '[PaymobiScraperService] Strategy C failed');
        }
      }
    }
  }

  return contracts;
}
