import type { ServerToClientEvents, ClientToServerEvents } from '@shared/contracts.js';
import type { Socket } from 'socket.io';
import logger from '../../utils/logger.js';

export type AthinaSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

/** Safely emit a socket event with error handling. */
export function safeEmit(socket: AthinaSocket, event: keyof ServerToClientEvents, data?: unknown): void {
  try {
    // cast: emit dinâmico por chave não é expressável no mapa tipado
    (socket.emit as (event: string, data?: unknown) => void)(event, data);
  } catch (err) {
    logger.error({ event, socketId: socket.id, error: err instanceof Error ? err.message : String(err) }, 'Socket emit failed');
  }
}
