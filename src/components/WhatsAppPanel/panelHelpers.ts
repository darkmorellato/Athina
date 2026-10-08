/**
 * @fileoverview Contact classification and hostility detection helpers.
 * Consolidated from types/constants.ts to avoid duplication.
 */
import type { Message } from '../../types/index.js';

// Re-export HOSTILE_TERMS from constants to maintain single source of truth
import { HOSTILE_TERMS } from '../../types/index.js';

export interface SectorInfo {
  label: string;
  sectorKey: string;
  className: string;
}

export const SECTOR_MAP: Record<string, SectorInfo> = {
  cobranca: {
    label: 'Cobrança',
    sectorKey: 'cobranca',
    className: 'bg-emerald-100 text-emerald-800 border border-emerald-200',
  },
  suporte: {
    label: 'Suporte',
    sectorKey: 'suporte',
    className: 'bg-blue-100 text-blue-800 border border-blue-200',
  },
  vendas: {
    label: 'Vendas',
    sectorKey: 'vendas',
    className: 'bg-amber-100 text-amber-800 border border-amber-200',
  },
};

/**
 * Classify a contact's sector based on message content.
 * Currently defaults to 'suporte' — extend with NLP/keyword logic as needed.
 */
export function classifyContact(_contactMsgs: Message[]): SectorInfo {
  return SECTOR_MAP.suporte;
}

/**
 * Detect hostile/aggressive language in a customer message.
 */
export function isHostile(msg: Message): boolean {
  if (msg.sender !== 'customer' || !msg.text) return false;
  const clean = msg.text.toLowerCase();
  return HOSTILE_TERMS.some((term) => clean.includes(term));
}
