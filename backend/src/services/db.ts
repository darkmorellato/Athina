/**
 * @fileoverview Banco SQLite local (node:sqlite nativo — ZERO dependências).
 *
 * Persiste treinamento (regras + Q&As) e analytics em `backend/data/athina.db`.
 * Na primeira execução importa o `learning_database.json` legado (uma vez) para
 * as tabelas — o JSON fica no repo apenas como arquivo-fonte/arquivo morto.
 *
 * Override para testes: env `ATHINA_DB_PATH` (ex.: ':memory:') ou use
 * `openDatabase('<caminho>')` diretamente.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_PATH = path.resolve(__dirname, '../../data/athina.db');
const LEGACY_JSON_PATH = path.resolve(__dirname, '../../learning_database.json');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS training_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ord INTEGER NOT NULL,
    text TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS training_qas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ord REAL NOT NULL,
    intent TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS analytics_stats (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS analytics_intents (
    intent TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0
  );
`;

export function openDatabase(dbPath: string = process.env.ATHINA_DB_PATH || DEFAULT_DB_PATH): DatabaseSync {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  migrateLegacyJsonOnce(db);
  return db;
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

/** Importa o learning_database.json (uma única vez) para as tabelas SQLite. */
function migrateLegacyJsonOnce(db: DatabaseSync): void {
  if (getMeta(db, 'json_migrated')) return;
  try {
    if (!fs.existsSync(LEGACY_JSON_PATH)) {
      setMeta(db, 'json_migrated', new Date().toISOString());
      return;
    }
    const raw = JSON.parse(fs.readFileSync(LEGACY_JSON_PATH, 'utf-8')) as {
      customRules?: unknown;
      qaExamples?: Array<{ intent?: string; question?: string; answer?: string }>;
    };
    const rules = Array.isArray(raw.customRules)
      ? raw.customRules.filter((r): r is string => typeof r === 'string')
      : [];
    const qas = Array.isArray(raw.qaExamples) ? raw.qaExamples : [];

    db.exec('BEGIN');
    try {
      const insertRule = db.prepare('INSERT INTO training_rules (ord, text) VALUES (?, ?)');
      const insertQa = db.prepare(
        'INSERT INTO training_qas (ord, intent, question, answer) VALUES (?, ?, ?, ?)'
      );
      rules.forEach((r, i) => insertRule.run(i, r));
      qas.forEach((qa, i) =>
        insertQa.run(i, String(qa.intent ?? 'Geral'), String(qa.question ?? ''), String(qa.answer ?? ''))
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    setMeta(db, 'json_migrated', new Date().toISOString());
    logger.info({ rules: rules.length, qas: qas.length }, 'learning_database.json importado para SQLite');
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Falha ao migrar learning_database.json — seguindo sem migração'
    );
    setMeta(db, 'json_migrated', new Date().toISOString()); // não repetir em loop
  }
}

// Conexão compartilhada da aplicação (lazy: abrir só quando alguém usar).
let shared: DatabaseSync | null = null;
export function getDb(): DatabaseSync {
  shared ??= openDatabase();
  return shared;
}
