/**
 * Smoke test LOCAL do processamento de PIX (Playwright): serve uma página
 * fake de pagamento (com os mesmos padrões de DOM que o portal usa) e valida
 * a extração do código copia-e-cola + screenshot de debug.
 *
 * Não toca em nenhum portal real.
 *
 * Uso: npx tsx tests/_pix_processor_smoke.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { chromium } from 'playwright';
import { processPixPayment } from '../src/services/helpers/paymobiPixProcessor.js';

const FIXTURE_PIX = '00020126BR.GOV.BCB.PIX-FIXTURE-AGENT-ATHINA';

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Pagamento PIX</title></head>
<body>
  <h1>Pague com PIX</h1>
  <p>CPF do titular: ***.456.789-**</p>
  <label>PIX copia e cola</label>
  <code id="pixcode">${FIXTURE_PIX}</code>
</body></html>`;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address() as { port: number };
const url = `http://127.0.0.1:${port}/boleto-fake`;

const browser = await chromium.launch({ headless: true });
let ok = false;
try {
  const result = await processPixPayment(browser, url);
  assert.equal(result.pixCode, FIXTURE_PIX, 'deveria extrair o código copia-e-cola do DOM');
  assert.equal(result.pixUrl, url, 'sem link cel.cash no conteúdo, mantém a URL original');
  assert.ok(fs.existsSync(result.qrCodePath), 'screenshot de debug deveria ser gerado');
  ok = true;
  console.log('  ✔ processPixPayment extraiu o PIX copia-e-cola e gerou screenshot');
  console.log(`    → ${result.qrCodePath}`);
} finally {
  await browser.close();
  server.close();
}

console.log(`\nPIX processor smoke: ${ok ? '1/1 cenários passaram' : 'FALHOU'}`);
if (!ok) process.exitCode = 1;
