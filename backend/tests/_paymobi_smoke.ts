/**
 * Smoke test REAL do portal Paymobi: login + busca de CPF.
 * CPF de teste com dígitos válidos (checksum ok), esperado não existir —
 * se o login e a busca funcionarem, retorna success:false com motivo
 * (em vez de erro de autenticação).
 *
 * Uso: npx tsx tests/_paymobi_smoke.ts
 */
import config from '../src/config/index.js';
import { PaymobiScraperService } from '../src/services/PaymobiScraperService.js';

const email = config.paymobiEmail;
const password = config.paymobiPassword;

if (!email || !password) {
  console.error('FALHA: PAYMOBI_EMAIL/PAYMOBI_PASSWORD não configurados no .env');
  process.exit(1);
}

console.log('Iniciando teste real no portal Paymobi (login + busca)...');
const started = Date.now();
const scraper = new PaymobiScraperService(email, password);

const result = await scraper.scrape({
  query: '11144477735', // CPF de teste válido por checksum, não cadastrado
  searchType: 'cpf',
});

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(`Tempo: ${elapsed}s`);
console.log('success:', result.success);
console.log('reason:', result.reason ?? '(sem)');
console.log('message:', (result.message ?? '(sem)').slice(0, 200));
if (result.data) console.log('data:', JSON.stringify(result.data).slice(0, 300));

const loginOk =
  result.success ||
  (typeof result.reason === 'string' &&
    !/login|auth|credential|senha|e-?mail inválid/i.test(result.reason)) ||
  (typeof result.message === 'string' &&
    /não encontr|nenhum|nenhuma|not found/i.test(result.message));

console.log(loginOk ? '\nOK: portal acessível, login e busca respondendo' : '\nFALHA: parece problema de login/autenticação');
process.exit(loginOk ? 0 : 1);
