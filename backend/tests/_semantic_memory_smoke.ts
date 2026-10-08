/**
 * Smoke da memória semântica: LanceDB + embeddings REAIS do NIM.
 * Usa um diretório temporário (não toca backend/data/lance-memory).
 *
 * Uso: npx tsx tests/_semantic_memory_smoke.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Módulos leem o env em TEMPO DE CHAMADA — setar aqui basta.
process.env.AGENT_SEMANTIC_MEMORY = 'true';
process.env.SEMANTIC_MEMORY_DIR = path.join(os.tmpdir(), `lance-smoke-${Date.now()}`);

import { addMemory, isSemanticMemoryEnabled, searchMemory } from '../src/services/semanticMemory.js';

assert.equal(isSemanticMemoryEnabled(), true, 'memória deveria estar ligada com AGENT_SEMANTIC_MEMORY=true');

const ok1 = await addMemory(
  'Pagamento por PIX desbloqueia o aparelho em até 1 minuto, desde que esteja conectado à internet.',
  'exchange'
);
const ok2 = await addMemory(
  'Boleto bancário compensa em até 3 dias úteis; com o comprovante podemos conceder uma extensão de pagamento.',
  'exchange'
);
assert.ok(ok1 && ok2, 'as duas gravações deveriam funcionar');

const hits = await searchMemory('Em quanto tempo meu celular libera depois do pix?', 2);
assert.ok(hits.length >= 1, 'a busca deveria retornar resultados');
assert.match(hits[0].text, /pix/i, 'a memória mais similar deveria ser a do PIX');
assert.ok(Number.isFinite(hits[0].distance), 'distância vetorial deveria ser numérica');

console.log('  ✔ gravação + busca com embeddings reais (', hits.length, 'resultados )');
console.log('    top1:', hits[0].text.slice(0, 90));
console.log('    distância:', hits[0].distance.toFixed(4));

fs.rmSync(process.env.SEMANTIC_MEMORY_DIR!, { recursive: true, force: true });
console.log('\nSemantic memory smoke: 1/1 cenários passaram');
