/**
 * @fileoverview Memória semântica opcional (LanceDB + embeddings do NIM).
 *
 * - `addMemory()` grava um texto + embedding no banco vetorial local
 *   (backend/data/lance-memory — gitignored).
 * - `searchMemory()` busca os k textos mais similares (usado para enriquecer
 *   o prompt do agente, quando a memória está ativada).
 *
 * Opt-in: `AGENT_SEMANTIC_MEMORY=true` no ambiente. Desligada = no-op total
 * (nenhuma conexão, nenhum embedding, zero overhead).
 *
 * Embeddings: `EMBEDDING_MODEL` (padrão abaixo) via endpoint OpenAI-compatible
 * já configurado (aiProvider). Diretório: `SEMANTIC_MEMORY_DIR` (opcional).
 */
import { connect, type Connection, type Table } from '@lancedb/lancedb';
import { embed } from 'ai';
import path from 'path';
import { fileURLToPath } from 'url';
import { aiProvider } from './aiProvider.js';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.resolve(__dirname, '../../data/lance-memory');
const TABLE_NAME = 'memoria';
const DEFAULT_EMBED_MODEL = 'nvidia/nemotron-3-embed-1b';

function enabled(): boolean {
  const v = process.env.AGENT_SEMANTIC_MEMORY;
  return v === 'true' || v === '1';
}

function dir(): string {
  return process.env.SEMANTIC_MEMORY_DIR || DEFAULT_DIR;
}

function embedModelId(): string {
  return process.env.EMBEDDING_MODEL || DEFAULT_EMBED_MODEL;
}

export function isSemanticMemoryEnabled(): boolean {
  return enabled();
}

let connection: Connection | null = null;

async function getConnection(): Promise<Connection> {
  connection ??= await connect(dir());
  return connection;
}

async function getTable(conn: Connection): Promise<Table | null> {
  const names = await conn.tableNames();
  return names.includes(TABLE_NAME) ? conn.openTable(TABLE_NAME) : null;
}

/** Embute e grava um texto na memória. Nunca lança (retorna false em erro). */
export async function addMemory(text: string, kind = 'exchange'): Promise<boolean> {
  if (!enabled()) return false;
  const clean = (text ?? '').trim().slice(0, 2000);
  if (clean.length < 5) return false;
  try {
    const { embedding } = await embed({
      model: aiProvider.embeddingModel(embedModelId()),
      value: clean,
    });
    const row = { vector: embedding, text: clean, kind, ts: Date.now() };
    const conn = await getConnection();
    const existing = await getTable(conn);
    if (existing) {
      await existing.add([row]);
    } else {
      await conn.createTable(TABLE_NAME, [row]);
    }
    return true;
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Semantic memory: addMemory falhou'
    );
    return false;
  }
}

/** Busca os k textos mais similares. Nunca lança (retorna [] em erro). */
export async function searchMemory(
  query: string,
  k = 3
): Promise<Array<{ text: string; distance: number }>> {
  if (!enabled()) return [];
  try {
    const { embedding } = await embed({
      model: aiProvider.embeddingModel(embedModelId()),
      value: query,
    });
    const conn = await getConnection();
    const tbl = await getTable(conn);
    if (!tbl) return [];
    const rows = (await tbl.vectorSearch(embedding).limit(k).toArray()) as Array<{
      text: string;
      _distance: number;
    }>;
    return rows.map((r) => ({ text: r.text, distance: r._distance }));
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Semantic memory: searchMemory falhou'
    );
    return [];
  }
}
