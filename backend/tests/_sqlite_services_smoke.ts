/**
 * Smoke test dos serviços com SQLite (node:sqlite nativo):
 * round-trip de treinamento, persistência entre instâncias, dedupe e
 * analytics durável (sobrevive a restart sem Redis).
 *
 * Uso: npx tsx tests/_sqlite_services_smoke.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/services/db.js';
import { TrainingService } from '../src/services/TrainingService.js';
import { AnalyticsService } from '../src/services/AnalyticsService.js';

let passed = 0;
const failures: Array<{ name: string; error: unknown }> = [];

async function scenario(name: string, run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`  ✘ ${name}`);
    console.error(error);
  }
}

const tmpDb = (): string =>
  path.join(os.tmpdir(), `athina-db-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

const rmDb = (file: string): void => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
};

await scenario('treinamento: setRules/setQas fazem round-trip preservando a ordem', () => {
  const svc = new TrainingService(openDatabase(':memory:'));
  svc.setRules(['Regra A', 'Regra B']);
  svc.setQas([
    { intent: 'i1', question: 'Pergunta um?', answer: 'Resposta um.' },
    { intent: 'i2', question: 'Pergunta dois?', answer: 'Resposta dois.' },
  ]);
  const t = svc.getTraining();
  assert.deepEqual(t.customRules, ['Regra A', 'Regra B']);
  assert.equal(t.qaExamples.length, 2);
  assert.equal(t.qaExamples[0].question, 'Pergunta um?');
  assert.equal(t.qaExamples[1].question, 'Pergunta dois?');
});

await scenario('treinamento: aprendizado persiste entre instâncias (mesmo arquivo)', () => {
  const file = tmpDb();
  try {
    const a = new TrainingService(openDatabase(file));
    a.learnFromExchange(
      'A loja atende no domingo?',
      'Não abrimos aos domingos — apenas de segunda a sábado.'
    );
    const b = new TrainingService(openDatabase(file));
    const block = b.getPromptBlock();
    assert.ok(block.includes('A loja atende no domingo?'), 'aprendizado deveria persistir no arquivo');
  } finally {
    rmDb(file);
  }
});

await scenario('treinamento: dedupe normalizado atualiza em vez de duplicar', () => {
  const svc = new TrainingService(openDatabase(':memory:'));
  svc.learnFromExchange('Como faço o pagamento?', 'Pelo PIX copia e cola, por favor.');
  svc.learnFromExchange('como faco o pagamento', 'Pelo PIX ou pelo boleto completo.');
  const qas = svc
    .getTraining()
    .qaExamples.filter((q) => /faco o pagamento|faço o pagamento/i.test(q.question));
  assert.equal(qas.length, 1, 'pergunta normalizada duplicada deve virar UMA');
  assert.ok(qas[0].answer.includes('boleto'), 'a resposta deve ser a mais recente');
});

await scenario('analytics: incrementos persistem entre instâncias e reset limpa', async () => {
  const file = tmpDb();
  try {
    const a = new AnalyticsService(openDatabase(file));
    await a.increment('autoResolved', 3);
    await a.trackIntent('boleto');
    await a.trackIntent('boleto');
    const b = new AnalyticsService(openDatabase(file));
    const stats = await b.getStats();
    assert.equal(stats.autoResolved, 3, 'contador deve persistir no arquivo');
    assert.equal(stats.intentCounts['boleto'], 2);
    await b.resetStats();
    const c = new AnalyticsService(openDatabase(file));
    const after = await c.getStats();
    assert.equal(after.autoResolved, 0);
    assert.equal(Object.keys(after.intentCounts).length, 0);
  } finally {
    rmDb(file);
  }
});

await scenario('migração: banco novo importa o learning_database.json legado', () => {
  const svc = new TrainingService(openDatabase(':memory:'));
  const t = svc.getTraining();
  assert.ok(t.customRules.length >= 3, 'regras (migradas ou padrão) presentes');
  assert.ok(
    t.qaExamples.length >= 1,
    'Q&As importados do JSON legado (a base real tem 16 pares)'
  );
});

console.log(`\nSQLite services smoke: ${passed}/5 cenários passaram`);
if (failures.length > 0) process.exitCode = 1;
