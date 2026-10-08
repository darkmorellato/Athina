/**
 * @fileoverview WhatsApp Web client service using whatsapp-web.js.
 */
import type { Client as WWebClient } from 'whatsapp-web.js';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import logger from '../utils/logger.js';
import chatStateService from './ChatStateService.js';
import { setupClientEvents, startUseHereAutomation, PUPPETEER_ARGS } from './helpers/whatsappClientSetup.js';
import { getRecentChats } from './helpers/whatsappChatHelper.js';
import { syncPhonebookContacts } from './helpers/whatsappPhonebookHelper.js';
import { handleIncomingMessage } from './helpers/whatsappMessageHelper.js';
import type { WhatsAppState, WhatsAppConnectionStatus } from '../types/index.js';
const __filename = fileURLToPath(import.meta.url);
export const STATES = Object.freeze({
  IDLE: 'IDLE' as WhatsAppState,
  INITIALIZING: 'INITIALIZING' as WhatsAppState,
  QR_RECEIVED: 'QR_RECEIVED' as WhatsAppState,
  AUTHENTICATING: 'AUTHENTICATING' as WhatsAppState,
  READY: 'READY' as WhatsAppState,
  DISCONNECTED: 'DISCONNECTED' as WhatsAppState,
});
class WhatsAppService {
  private state: WhatsAppState = STATES.IDLE;
  private lastQR: string | null = null;
  private client: WWebClient | null = null;
  private isInitializing = false;
  private useHereInterval: ReturnType<typeof setInterval> | null = null;
  private emitter: import('socket.io').Server | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private cachedChats: Array<{ id: string; name: string; messages: any[] }> | null = null;
  private lastCacheTime = 0;
  private fetchPromise: Promise<Array<{ id: string; name: string; messages: any[] }>> | null = null;
  private phonebookContacts: any[] = [];
  private contactNameMap = new Map<string, string>();
  private isSyncingPhonebook = false;
  private cacheCleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly MAX_CACHE_SIZE = 1000;
  private readonly MAX_CONTACT_MAP_SIZE = 5000;

  setEmitter(emitter: import('socket.io').Server | null): void { this.emitter = emitter; }
  private emit(event: string, data?: unknown): void { this.emitter?.emit(event, data); }
  private setState(newState: WhatsAppState): void {
    logger.info({ from: this.state, to: newState }, 'WhatsApp state transition');
    this.state = newState;
  }
  getClientState(): WhatsAppState { return this.state; }
  getLastQR(): string | null { return this.lastQR; }
  getConnectionStatus(): WhatsAppConnectionStatus { return { state: this.state, isConnected: this.state === STATES.READY, lastQR: this.lastQR }; }

  /** Expose client safely for authorized operations (e.g., sending messages). */
  getClient(): WWebClient | null { return this.client; }

  private getHelperContext() {
    return {
      client: this.client, state: this.state, phonebookContacts: this.phonebookContacts,
      setPhonebookContacts: (contacts: any[]) => { this.phonebookContacts = contacts; },
      contactNameMap: this.contactNameMap, isSyncingPhonebook: this.isSyncingPhonebook,
      setIsSyncingPhonebook: (val: boolean) => { this.isSyncingPhonebook = val; },
      cachedChats: this.cachedChats, setCachedChats: (chats: any[] | null) => { this.cachedChats = chats; },
      lastCacheTime: this.lastCacheTime, setLastCacheTime: (time: number) => { this.lastCacheTime = time; },
      fetchPromise: this.fetchPromise, setFetchPromise: (promise: Promise<any> | null) => { this.fetchPromise = promise; },
      emit: (event: string, data?: any) => this.emit(event, data),
    };
  }

  async syncPhonebookContacts(): Promise<void> { return syncPhonebookContacts(this.getHelperContext()); }
  async getRecentChats(): Promise<Array<{ id: string; name: string; messages: any[] }>> { return getRecentChats(this.getHelperContext()); }

  async clearSession(): Promise<void> {
    const authPath = path.resolve(path.dirname(__filename), '../../.wwebjs_auth');
    const cachePath = path.resolve(path.dirname(__filename), '../../.wwebjs_cache');
    
    // Kill zombie browser processes first
    this.killZombieBrowsers();
    
    // Remove lock files before deleting directory
    const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
    for (const lockFile of lockFiles) {
      const lockPath = path.join(authPath, 'session', lockFile);
      try {
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
      } catch { /* ignore */ }
    }
    
    try {
      if (fs.existsSync(authPath)) {
        fs.rmSync(authPath, { recursive: true, force: true });
        logger.info('WhatsApp auth session directory cleared.');
      }
      if (fs.existsSync(cachePath)) {
        fs.rmSync(cachePath, { recursive: true, force: true });
        logger.info('WhatsApp cache directory cleared.');
      }
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Failed to clear session/cache directories');
    }
  }

  /** Kill zombie Chrome/Chromium processes spawned by whatsapp-web.js ONLY.
   *  Scoping by the session dir avoids killing the user's own browser. */
  private killZombieBrowsers(): void {
    try {
      const platform = process.platform;
      // Security fix: Use safer commands with timeout to prevent command injection
      if (platform === 'win32') {
        execSync('taskkill /F /IM chrome.exe /T 2>nul', { stdio: 'ignore', timeout: 5000 });
        execSync('taskkill /F /IM chromium.exe /T 2>nul', { stdio: 'ignore', timeout: 5000 });
      } else {
        // Only processes whose command line references our auth/session dir.
        execSync("pkill -9 -f '\\.wwebjs_auth' 2>/dev/null || true", { stdio: 'ignore', timeout: 5000 });
      }
      logger.info('Zombie browser processes cleaned');
    } catch (err) {
      // Ignore - processes may not exist or timeout
      logger.debug('No zombie browser processes found or cleanup timed out');
    }
  }

  async init(delay = 0): Promise<void> {
    if (this.isInitializing) {
      logger.warn('WhatsApp client already initializing, skipping...');
      return;
    }

    this.isInitializing = true;
    this.emit('server-status', 'A inicializar o sistema...');
    
    // Start cache cleanup interval
    this.startCacheCleanup();

    if (delay > 0) {
      logger.info({ delayMs: delay }, 'Waiting before init...');
      await new Promise((res) => setTimeout(res, delay));
    }
    if (this.client) {
      logger.info('Destroying existing client before re-init...');
      await this.destroy();
    }

    this.setState(STATES.INITIALIZING);
    logger.info('Configuring WhatsApp client...');

    const authPath = path.resolve(path.dirname(__filename), '../../.wwebjs_auth');
    logger.info({ authPath }, 'Auth path resolved');

    // Crash dumps are routinely created when Chrome is force-killed (e.g. dev
    // hot-reloads). They do NOT indicate a corrupted session — deleting the
    // session here would force a new QR scan on every restart. Only remove the
    // dump files; real corruption is handled by the init-failure retry below.
    const crashDir = path.join(authPath, 'session', 'Crashpad', 'reports');
    if (fs.existsSync(crashDir)) {
      try {
        const crashFiles = fs.readdirSync(crashDir).filter((f) => f.endsWith('.dmp'));
        for (const file of crashFiles) {
          fs.unlinkSync(path.join(crashDir, file));
        }
        if (crashFiles.length > 0) {
          logger.info({ removed: crashFiles.length }, 'Removed stale Chrome crash dumps (session preserved)');
        }
      } catch (err) {
        logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'Failed to clean crash dumps');
      }
    }

    try {
      const client = new Client({
        authStrategy: new LocalAuth({ dataPath: authPath }),
        puppeteer: { headless: true, args: [...PUPPETEER_ARGS], protocolTimeout: 300000 },
      });

      this.setupEvents(client);
      this.useHereInterval = startUseHereAutomation(client);
      this.client = client;

      logger.info('Client created, initializing...');
      await client.initialize();
      logger.info('Client initialized successfully');
    } catch (err) {
      const errorStr = err instanceof Error ? err.message : String(err);
      logger.error({ error: errorStr }, 'WhatsApp init failed');

      // Retry policy (session-preserving):
      // 1st/2nd failure -> retry WITHOUT clearing. Transient errors during
      //                    hot-reloads (TargetCloseError, browser/profile
      //                    conflicts) are common and must NOT log the user out.
      // 3rd failure     -> clear the session and retry once (truly broken session).
      const attempt = this.reconnectAttempts ?? 0;
      if (attempt < 3) {
        if (attempt === 2) {
          logger.warn('Init failed repeatedly — clearing session and retrying (last resort)...');
          await this.clearSession();
        } else {
          logger.warn('Init failed — retrying WITHOUT clearing session (transient error)...');
        }
        this.reconnectAttempts = attempt + 1;
        this.isInitializing = false;
        return this.init(5000); // Retry after 5 seconds
      }

      this.isInitializing = false;
      this.setState(STATES.DISCONNECTED);
      this.scheduleReconnect();
      return;
    }

    this.isInitializing = false;
  }

  private setupEvents(client: WWebClient): void {
    logger.info('Setting up WhatsApp client events...');
    setupClientEvents(client, {
      onQR: (qr: string) => {
        // Security fix: Do not log QR code content to prevent credential exposure
        logger.info({ qrLength: qr.length }, 'QR code received from WhatsApp');
        this.lastQR = qr;
        this.setState(STATES.QR_RECEIVED);
        logger.info('Emitting whatsapp-qr event...');
        this.emit('whatsapp-qr', qr);
        logger.info('whatsapp-qr event emitted');
      },
      onReady: async () => {
        this.lastQR = null;
        this.reconnectAttempts = 0;
        this.setState(STATES.READY);
        this.emit('whatsapp-ready');
        this.syncPhonebookContacts().catch(() => {});
        try {
          const chats = await this.getRecentChats();
          this.emit('chats-loaded', chats);
        } catch (err) {
          logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Failed to load chats on ready');
        }

        // O WhatsApp Web carrega chats/contatos de forma incremental após o
        // READY. Reenvia a lista completa ~45s depois (e após o phonebook sync)
        // para o painel não ficar com dados parciais.
        setTimeout(() => {
          if (this.state !== STATES.READY) return;
          this.getRecentChats()
            .then((chats) => this.emit('chats-loaded', chats))
            .catch((err) => {
              logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Delayed chat refresh failed');
            });
        }, 45000).unref?.();
      },
      onAuthenticated: () => {
        this.setState(STATES.AUTHENTICATING);
        this.emit('server-status', 'Autenticado! A carregar conversas...');
      },
      onAuthFailure: () => {
        this.destroy()
          .then(() => this.clearSession())
          .then(() => this.scheduleReconnect());
      },
      onDisconnected: (reason: string) => {
        logger.warn({ reason }, 'WhatsApp disconnected');
        this.emit('server-status', `Desconectado: ${reason}`);
        this.destroy()
          .then(() => {
            if (reason === 'LOGOUT') {
              logger.info('Logout detected, clearing session');
              return this.clearSession();
            }
            return Promise.resolve();
          })
          .then(() => this.scheduleReconnect());
      },
      onLoading: (percent: number, message: string) => {
        this.emit('server-status', `A carregar: ${percent}% - ${message}`);
      },
      onMessage: (msg: any) => {
        // Mensagem do CLIENTE → rearma o reinício automático (5 min de
        // ausência reinicia o atendimento do zero). Funciona também no
        // modo autônomo, onde o painel não consulta o estado.
        if (msg && msg.fromMe !== true && typeof msg.from === 'string') {
          try {
            chatStateService.touchActivity(msg.from);
          } catch {
            /* contactId malformado — ignora */
          }
        }
        handleIncomingMessage(msg, (event, data) => this.emit(event, data)).catch(() => {});
        // Autonomous server-side auto-reply (enabled via AGENT_AUTOREPLY=true).
        // Dynamic import avoids a circular dependency between the services.
        if (msg && msg.fromMe !== true) {
          import('./AgentService.js')
            .then(({ default: agentService }) => agentService.handleIncomingMessage(msg))
            .catch((err) => {
              logger.error(
                { error: err instanceof Error ? err.message : String(err) },
                'Failed to dispatch message to autonomous agent'
              );
            });
        }
      },
    });
  }

  private scheduleReconnect(): void {
    const backoff = Math.min(300000, 3000 * Math.pow(2, this.reconnectAttempts++));
    logger.info({ backoffMs: backoff }, 'Scheduling reconnect');
    this.reconnectTimer = setTimeout(() => this.init(), backoff);
  }

  /** Cleanup cache periodically to prevent memory leaks */
  private startCacheCleanup(): void {
    if (this.cacheCleanupInterval) {
      return; // Already running
    }
    
    this.cacheCleanupInterval = setInterval(() => {
      // Clean cached chats if exceeds limit
      if (this.cachedChats && this.cachedChats.length > this.MAX_CACHE_SIZE) {
        const excess = this.cachedChats.length - this.MAX_CACHE_SIZE;
        this.cachedChats = this.cachedChats.slice(excess);
        logger.info({ cleaned: excess, remaining: this.cachedChats.length }, 'Cleaned cached chats');
      }
      
      // Clean contact name map if exceeds limit
      if (this.contactNameMap.size > this.MAX_CONTACT_MAP_SIZE) {
        const excess = this.contactNameMap.size - this.MAX_CONTACT_MAP_SIZE;
        const keysToDelete = Array.from(this.contactNameMap.keys()).slice(0, excess);
        keysToDelete.forEach(key => this.contactNameMap.delete(key));
        logger.info({ cleaned: excess, remaining: this.contactNameMap.size }, 'Cleaned contact map');
      }
    }, 300000); // Every 5 minutes
  }

  async destroy(): Promise<void> {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.useHereInterval) { clearInterval(this.useHereInterval); this.useHereInterval = null; }
    if (this.cacheCleanupInterval) { clearInterval(this.cacheCleanupInterval); this.cacheCleanupInterval = null; }
    if (this.client) {
      try {
        this.client.removeAllListeners();
        await this.client.destroy();
        logger.info('WhatsApp client destroyed');
      } catch (e) {
        logger.warn({ error: e instanceof Error ? e.message : String(e) }, 'Destroy error');
      }
      this.client = null;
    }
    this.setState(STATES.DISCONNECTED);
    this.isInitializing = false;
  }
}

export default new WhatsAppService();