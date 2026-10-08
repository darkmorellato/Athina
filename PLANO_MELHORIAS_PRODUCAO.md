# 📋 PLANO DE MELHORIAS PARA PRODUÇÃO
## Agent-Athina - Revisão Completa

**Data:** 07/10/2026  
**Objetivo:** Preparar o projeto para uso em produção com segurança, performance e confiabilidade

> **✅ STATUS (07/10/2026): FASE 1 IMPLEMENTADA**
> Todas as 15 correções críticas foram aplicadas no backend e frontend.
> Typecheck, build (backend + frontend) e testes de fumaça via socket passaram.
> Veja a lista completa de correções aplicadas no final deste documento (seção "CORREÇÕES APLICADAS").

---

## 🎯 RESUMO EXECUTIVO

### Status Atual
- ✅ **Estrutura**: Bem organizada (Frontend React + Backend Node.js + TTS Python)
- ✅ **Auditoria Prévia**: 21/21 melhorias implementadas (veja AUDIT_REPORT.md)
- ⚠️ **Segurança**: 13 vulnerabilidades críticas identificadas
- ⚠️ **Dependências**: 36 pacotes desatualizados (alguns com breaking changes)
- ⚠️ **Performance**: Memory leaks e race conditions identificados

### Prioridades de Implementação
1. **CRÍTICO** (Imediato): 13 vulnerabilidades de segurança
2. **ALTO** (1-2 semanas): 23 problemas de confiabilidade
3. **MÉDIO** (1 mês): 18 melhorias de qualidade
4. **ATUALIZAÇÃO** (1 semana): Dependências desatualizadas

---

## 🔴 FASE 1: CORREÇÕES CRÍTICAS (IMEDIATO)

### 1.1 WhatsAppService.ts

#### Problema 1: Exposição de QR Code em Logs
**Arquivo:** `backend/src/services/WhatsAppService.ts:191`
```typescript
// ❌ ANTES
logger.info({ qr: qr.substring(0, 200) }, 'QR code generated');

// ✅ DEPOIS
logger.info('QR code generated (length: ' + qr.length + ')');
```

#### Problema 2: Command Injection via execSync
**Arquivo:** `backend/src/services/WhatsAppService.ts:106-110`
```typescript
// ❌ ANTES
execSync('taskkill /F /IM chrome.exe /T', { stdio: 'ignore' });

// ✅ DEPOIS - Usar biblioteca específica
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

private async killChromeProcesses() {
  const isWindows = process.platform === 'win32';
  try {
    if (isWindows) {
      await execAsync('taskkill /F /IM chrome.exe /T', { timeout: 5000 });
    } else {
      await execAsync('pkill -9 chrome', { timeout: 5000 });
    }
  } catch (error) {
    logger.debug('No Chrome processes to kill');
  }
}
```

#### Problema 3: Memory Leak - Singleton sem Cleanup
**Arquivo:** `backend/src/services/WhatsAppService.ts`
```typescript
// ✅ ADICIONAR método de limpeza periódica
private startCacheCleanup() {
  setInterval(() => {
    const maxSize = 1000;
    if (this.cachedChats.size > maxSize) {
      const entriesToDelete = this.cachedChats.size - maxSize;
      const keys = Array.from(this.cachedChats.keys());
      for (let i = 0; i < entriesToDelete; i++) {
        this.cachedChats.delete(keys[i]);
      }
      logger.info(`Cleaned ${entriesToDelete} cached chats`);
    }
  }, 300000); // A cada 5 minutos
}

// Chamar no constructor ou init()
```

---

### 1.2 AIService.ts

#### Problema 1: Input Sanitization
**Arquivo:** `backend/src/services/AIService.ts:78,83`
```typescript
// ✅ ADICIONAR validação
import { z } from 'zod';

const messageSchema = z.object({
  message: z.string().max(4000).min(1),
  persona: z.string().max(1000).optional()
});

public async generateResponse(data: GenerateResponseData): Promise<string> {
  // Validar input
  const validated = messageSchema.parse({
    message: data.message,
    persona: data.persona
  });
  
  // Sanitizar para evitar prompt injection
  const sanitizedMessage = validated.message
    .replace(/system:/gi, '')
    .replace(/assistant:/gi, '')
    .replace(/user:/gi, '');
  
  // Resto do código...
}
```

#### Problema 2: Timeout e Retry Logic
**Arquivo:** `backend/src/services/AIService.ts:59`
```typescript
// ✅ ADICIONAR retry logic
import axios, { AxiosError } from 'axios';

private async makeRequest(data: any, retries = 3): Promise<any> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.post(this.apiUrl, data, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000, // Reduzido de 60s para 30s
      });
      return response.data;
    } catch (error) {
      const isRetryable = error instanceof AxiosError && 
        (!error.response || error.response.status >= 500);
      
      if (attempt === retries || !isRetryable) {
        throw error;
      }
      
      const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
      await new Promise(resolve => setTimeout(resolve, delay));
      logger.warn(`Retry attempt ${attempt}/${retries} after ${delay}ms`);
    }
  }
}
```

---

### 1.3 TTSService.ts

#### Problema 1: Synchronous File Operations
**Arquivo:** `backend/src/services/TTSService.ts:62`
```typescript
// ❌ ANTES
const audioBuffer = fs.readFileSync(response.data.filePath);

// ✅ DEPOIS
import { promises as fs } from 'fs';
import path from 'path';

private async readAudioFile(filePath: string): Promise<Buffer> {
  // Validar path para evitar path traversal
  const normalizedPath = path.normalize(filePath);
  const allowedDir = '/tmp/tts'; // Diretório permitido
  
  if (!normalizedPath.startsWith(allowedDir)) {
    throw new Error('Invalid file path');
  }
  
  try {
    const audioBuffer = await fs.readFile(normalizedPath);
    // Limpar arquivo após leitura
    await fs.unlink(normalizedPath).catch(() => {});
    return audioBuffer;
  } catch (error) {
    logger.error({ error, filePath }, 'Failed to read audio file');
    throw error;
  }
}
```

---

### 1.4 PaymobiScraperService.ts

#### Problema 1: Shared Browser Race Condition
**Arquivo:** `backend/src/services/PaymobiScraperService.ts:13-24`
```typescript
// ✅ IMPLEMENTAR mutex/lock
import { Mutex } from 'async-mutex';

class PaymobiScraperService {
  private static browserMutex = new Mutex();
  private static sharedBrowser: Browser | null = null;
  
  private async getBrowser(): Promise<Browser> {
    return await PaymobiScraperService.browserMutex.runExclusive(async () => {
      if (!PaymobiScraperService.sharedBrowser) {
        PaymobiScraperService.sharedBrowser = await puppeteer.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
      }
      return PaymobiScraperService.sharedBrowser;
    });
  }
  
  // Adicionar cleanup adequado
  private async closeBrowser(): Promise<void> {
    await PaymobiScraperService.browserMutex.runExclusive(async () => {
      if (PaymobiScraperService.sharedBrowser) {
        await PaymobiScraperService.sharedBrowser.close();
        PaymobiScraperService.sharedBrowser = null;
      }
    });
  }
}
```

**Instalar dependência:**
```bash
cd backend && npm install async-mutex
```

#### Problema 2: Mascarar Dados Sensíveis em Logs
**Arquivo:** `backend/src/services/PaymobiScraperService.ts:42`
```typescript
// ✅ ADICIONAR função de mascaramento
private maskSensitiveData(data: string): string {
  // Mascarar CPF: 123.456.789-00 -> 123.***.***-**
  data = data.replace(/(\d{3})\.(\d{3})\.(\d{3})-(\d{2})/g, '$1.***.***-**');
  // Mascarar IMEI: 123456789012345 -> 123***********5
  data = data.replace(/(\d{3})(\d{11})(\d{1})/g, '$1***********$3');
  return data;
}

// Usar nos logs
logger.info({ query: this.maskSensitiveData(params.query) }, 'Searching contracts');
```

---

### 1.5 SocketController.ts

#### Problema 1: RateLimiter Memory Leak
**Arquivo:** `backend/src/controllers/SocketController.ts:21-48`
```typescript
// ✅ ADICIONAR cleanup periódico
private startRateLimiterCleanup() {
  setInterval(() => {
    const now = Date.now();
    const maxAge = 600000; // 10 minutos
    
    for (const [socketId, timestamps] of this.rateLimiter.clients.entries()) {
      const recentTimestamps = timestamps.filter(ts => now - ts < maxAge);
      
      if (recentTimestamps.length === 0) {
        this.rateLimiter.clients.delete(socketId);
      } else {
        this.rateLimiter.clients.set(socketId, recentTimestamps);
      }
    }
    
    logger.debug(`Rate limiter cleanup: ${this.rateLimiter.clients.size} active clients`);
  }, 300000); // A cada 5 minutos
}

// Chamar no constructor
constructor(io: Server) {
  this.io = io;
  this.startRateLimiterCleanup();
}
```

#### Problema 2: Auth Bypass em restart-whatsapp
**Arquivo:** `backend/src/controllers/SocketController.ts:277`
```typescript
// ❌ ANTES
if (config.adminSecret && token !== config.adminSecret) {
  return callback({ success: false, error: 'Unauthorized' });
}

// ✅ DEPOIS
if (!config.adminSecret) {
  logger.error('Admin secret not configured');
  return callback({ success: false, error: 'Admin operations not available' });
}

if (token !== config.adminSecret) {
  logger.warn({ socketId: socket.id }, 'Unauthorized restart attempt');
  return callback({ success: false, error: 'Unauthorized' });
}
```

#### Problema 3: Input Validation
**Arquivo:** `backend/src/controllers/SocketController.ts` (múltiplos handlers)
```typescript
// ✅ CRIAR schemas de validação
import { z } from 'zod';

const sendMessageSchema = z.object({
  chatId: z.string().min(1).max(100),
  message: z.string().min(1).max(10000),
  options: z.object({
    mentions: z.array(z.string()).optional(),
    quotedMessageId: z.string().optional()
  }).optional()
});

const athinaConfigSchema = z.object({
  model: z.string().optional(),
  persona: z.string().max(2000).optional(),
  voiceMode: z.boolean().optional()
});

// Usar nos handlers
socket.on('send-message', async (data: any, callback) => {
  try {
    const validated = sendMessageSchema.parse(data);
    // Processar validated ao invés de data
  } catch (error) {
    if (error instanceof z.ZodError) {
      return callback({ success: false, error: 'Invalid input' });
    }
    throw error;
  }
});
```

---

### 1.6 ChatStateService.ts

#### Problema: Race Condition em setState
**Arquivo:** `backend/src/services/ChatStateService.ts:61-83`
```typescript
// ✅ USAR transações Redis
import Redis from 'ioredis';

public async setState(
  contactId: string,
  state: ChatState['stage'],
  data?: Partial<ChatState>
): Promise<void> {
  const key = this.getKey(contactId);
  
  // Usar WATCH/MULTI/EXEC para operação atômica
  const multi = this.redis.multi();
  
  try {
    const current = await this.getState(contactId);
    const updated: ChatState = {
      ...current,
      stage: state,
      ...(data || {}),
      timestamp: Date.now()
    };
    
    multi.setex(key, this.ttl, JSON.stringify(updated));
    await multi.exec();
    
    this.memoryStates.set(contactId, updated);
    
    logger.debug({ contactId, state }, 'Chat state updated');
  } catch (error) {
    logger.error({ error, contactId }, 'Failed to set chat state');
    throw error;
  }
}
```

#### Problema 2: Memory Map sem Limite
**Arquivo:** `backend/src/services/ChatStateService.ts:41`
```typescript
// ✅ IMPLEMENTAR LRU Cache
import LRU from 'lru-cache';

class ChatStateService {
  private memoryStates: LRU<string, ChatState>;
  
  constructor() {
    this.memoryStates = new LRU<string, ChatState>({
      max: 1000, // Máximo de 1000 entradas
      ttl: 86400000, // TTL de 24 horas
      updateAgeOnGet: true
    });
  }
}
```

**Instalar dependência:**
```bash
cd backend && npm install lru-cache @types/lru-cache
```

---

### 1.7 AnalyticsService.ts

#### Problema: Race Condition em increment
**Arquivo:** `backend/src/services/AnalyticsService.ts:83-95`
```typescript
// ❌ ANTES (não atômico)
const stats = await this.getStats();
stats[stat] = (stats[stat] || 0) + 1;
await this.updateStats({ [stat]: stats[stat] });

// ✅ DEPOIS (usar HINCRBY do Redis)
public async increment(stat: keyof Omit<Stats, 'intentCounts'>): Promise<void> {
  try {
    await this.redis.hincrby('analytics:stats', stat, 1);
    
    // Atualizar cache em memória
    const current = this.memoryStats[stat] as number || 0;
    this.memoryStats = {
      ...this.memoryStats,
      [stat]: current + 1
    };
    
    logger.debug({ stat }, 'Analytics stat incremented');
  } catch (error) {
    logger.error({ error, stat }, 'Failed to increment stat');
  }
}
```

---

## 🟠 FASE 2: MELHORIAS DE ALTO IMPACTO (1-2 SEMANAS)

### 2.1 Implementar Circuit Breakers

**Objetivo:** Prevenir cascata de falhas em serviços externos

```typescript
// backend/src/utils/circuitBreaker.ts
import { EventEmitter } from 'events';

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN'
}

export class CircuitBreaker extends EventEmitter {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private nextAttempt = Date.now();
  
  constructor(
    private threshold: number = 5,
    private timeout: number = 60000,
    private resetTimeout: number = 30000
  ) {
    super();
  }
  
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() < this.nextAttempt) {
        throw new Error('Circuit breaker is OPEN');
      }
      this.state = CircuitState.HALF_OPEN;
      this.emit('halfOpen');
    }
    
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
  
  private onSuccess() {
    this.failureCount = 0;
    
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= 2) {
        this.state = CircuitState.CLOSED;
        this.successCount = 0;
        this.emit('close');
      }
    }
  }
  
  private onFailure() {
    this.failureCount++;
    this.successCount = 0;
    
    if (this.failureCount >= this.threshold) {
      this.state = CircuitState.OPEN;
      this.nextAttempt = Date.now() + this.resetTimeout;
      this.emit('open');
    }
  }
  
  getState(): CircuitState {
    return this.state;
  }
}
```

**Usar em serviços:**
```typescript
// backend/src/services/AIService.ts
import { CircuitBreaker } from '../utils/circuitBreaker.js';

class AIService {
  private circuitBreaker = new CircuitBreaker(5, 60000, 30000);
  
  constructor() {
    this.circuitBreaker.on('open', () => {
      logger.warn('AI Service circuit breaker OPEN');
    });
    this.circuitBreaker.on('close', () => {
      logger.info('AI Service circuit breaker CLOSED');
    });
  }
  
  public async generateResponse(data: GenerateResponseData): Promise<string> {
    return await this.circuitBreaker.execute(async () => {
      // Lógica existente
    });
  }
}
```

---

### 2.2 Adicionar Health Checks Completos

**Arquivo:** `backend/src/server.ts`
```typescript
// ✅ EXPANDIR health check
app.get('/health', async (_req, res) => {
  const health = {
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    services: {
      whatsapp: {
        status: 'unknown',
        state: whatsAppService.getClientState()
      },
      redis: {
        status: 'unknown'
      },
      ai: {
        status: 'unknown'
      }
    },
    memory: {
      used: process.memoryUsage().heapUsed,
      total: process.memoryUsage().heapTotal,
      rss: process.memoryUsage().rss
    }
  };
  
  try {
    // Testar Redis
    await chatStateService.redis.ping();
    health.services.redis.status = 'healthy';
  } catch (error) {
    health.services.redis.status = 'unhealthy';
    health.status = 'degraded';
  }
  
  // Verificar WhatsApp
  health.services.whatsapp.status = 
    health.services.whatsapp.state === 'ready' ? 'healthy' : 'degraded';
  
  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

// Adicionar endpoint de readiness
app.get('/ready', async (_req, res) => {
  const ready = whatsAppService.getClientState() === 'ready';
  res.status(ready ? 200 : 503).json({ ready });
});
```

---

### 2.3 Implementar Monitoramento de Performance

**Criar:** `backend/src/middleware/metrics.ts`
```typescript
import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger.js';

interface Metrics {
  requests: number;
  errors: number;
  latency: number[];
}

const metrics: Metrics = {
  requests: 0,
  errors: 0,
  latency: []
};

export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  
  metrics.requests++;
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    metrics.latency.push(duration);
    
    // Manter apenas últimas 1000 medições
    if (metrics.latency.length > 1000) {
      metrics.latency.shift();
    }
    
    if (res.statusCode >= 400) {
      metrics.errors++;
    }
    
    if (duration > 1000) {
      logger.warn({ path: req.path, duration }, 'Slow request');
    }
  });
  
  next();
}

export function getMetrics() {
  const latency = metrics.latency;
  const avg = latency.reduce((a, b) => a + b, 0) / latency.length || 0;
  const sorted = [...latency].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
  const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;
  
  return {
    requests: metrics.requests,
    errors: metrics.errors,
    errorRate: (metrics.errors / metrics.requests) * 100 || 0,
    latency: {
      avg,
      p95,
      p99,
      min: sorted[0] || 0,
      max: sorted[sorted.length - 1] || 0
    }
  };
}
```

**Adicionar endpoint:**
```typescript
// backend/src/server.ts
import { metricsMiddleware, getMetrics } from './middleware/metrics.js';

app.use(metricsMiddleware);

app.get('/metrics', (_req, res) => {
  res.json(getMetrics());
});
```

---

### 2.4 Implementar Rate Limiting Global

**Instalar dependência:**
```bash
cd backend && npm install express-rate-limit
```

**Configurar:**
```typescript
// backend/src/server.ts
import rateLimit from 'express-rate-limit';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // limite de 100 requisições por janela
  message: 'Too many requests from this IP',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', limiter);
```

---

## 🟡 FASE 3: ATUALIZAÇÃO DE DEPENDÊNCIAS

### 3.1 Atualizar Dependências Críticas

**Frontend:**
```bash
cd /home/dark/Codes/Agent-Athina

# Atualizar dependências compatíveis (sem breaking changes)
npm update @tailwindcss/postcss @types/react @types/react-dom \
  @typescript-eslint/eslint-plugin @typescript-eslint/parser \
  @vitejs/plugin-react autoprefixer eslint \
  eslint-plugin-react-refresh globals lucide-react postcss \
  react react-dom socket.io-client tailwind-merge vite

# Atualizar concurrently (major version)
npm install concurrently@latest

# Atualizar framer-motion (major version - verificar breaking changes)
npm install framer-motion@latest
```

**Backend:**
```bash
cd /home/dark/Codes/Agent-Athina/backend

# Atualizar dependências compatíveis
npm update @gradio/client axios pino-pretty puppeteer socket.io tsx

# Atualizar com cuidado (major versions)
npm install bullmq@latest  # 5.x -> 6.x
npm install dotenv@latest  # 17.x -> 18.x

# Verificar se ioredis 6.x é compatível antes de atualizar
# npm install ioredis@latest

# Verificar se pino 10.x é compatível
# npm install pino@latest
```

**IMPORTANTE:** Após cada atualização major, executar:
```bash
npm run build
npm run typecheck
```

---

### 3.2 Adicionar Scripts de Produção

**Arquivo:** `package.json` (raiz)
```json
{
  "scripts": {
    "build:all": "npm run build && npm --prefix backend run build",
    "start:prod": "npm --prefix backend run start",
    "test": "npm run lint && npm --prefix backend run typecheck",
    "docker:build": "docker build -t agent-athina .",
    "docker:run": "docker run -p 3001:3001 -p 5173:5173 agent-athina"
  }
}
```

**Arquivo:** `backend/package.json`
```json
{
  "scripts": {
    "start:prod": "NODE_ENV=production tsx src/server.ts",
    "build:watch": "tsc --watch"
  }
}
```

---

## 🐳 FASE 4: CONTAINERIZAÇÃO (OPCIONAL)

### 4.1 Criar Dockerfile

**Criar:** `Dockerfile`
```dockerfile
# Multi-stage build
FROM node:20-alpine AS frontend-builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Backend stage
FROM node:20-alpine AS backend-builder

WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ .
RUN npm run build

# Production stage
FROM node:20-alpine

# Instalar Python para TTS
RUN apk add --no-cache python3 py3-pip

WORKDIR /app

# Copiar builds
COPY --from=frontend-builder /app/dist ./dist
COPY --from=backend-builder /app/backend/dist ./backend/dist
COPY --from=backend-builder /app/backend/node_modules ./backend/node_modules
COPY backend/package.json ./backend/
COPY backend/*.py ./backend/

# Instalar dependências Python TTS
RUN pip3 install flask gradio numpy

EXPOSE 3001 5173

CMD ["node", "backend/dist/server.js"]
```

### 4.2 Criar docker-compose.yml

**Criar:** `docker-compose.yml`
```yaml
version: '3.8'

services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    restart: unless-stopped
  
  app:
    build: .
    ports:
      - "3001:3001"
      - "5173:5173"
    environment:
      - NODE_ENV=production
      - REDIS_HOST=redis
      - REDIS_PORT=6379
    env_file:
      - backend/.env
    depends_on:
      - redis
    restart: unless-stopped
    volumes:
      - ./backend/.wwebjs_auth:/app/backend/.wwebjs_auth

volumes:
  redis-data:
```

---

## 📚 FASE 5: DOCUMENTAÇÃO

### 5.1 Criar Guia de Deploy

**Criar:** `DEPLOY.md`
```markdown
# 🚀 Guia de Deploy - Agent Athina

## Pré-requisitos

- Node.js 20+
- Redis 7+
- Python 3.10+
- Conta NVIDIA API (https://build.nvidia.com/)
- Credenciais Paymobi (se usar integração)

## Instalação

### 1. Clonar e Instalar Dependências

```bash
git clone <repo-url>
cd Agent-Athina
npm install
cd backend && npm install
```

### 2. Configurar Variáveis de Ambiente

```bash
cp backend/.env.example backend/.env
```

Editar `backend/.env` com suas credenciais:

```env
NVIDIA_API_KEY=nvapi-YOUR_KEY
ADMIN_SECRET=<gerar com: openssl rand -hex 32>
ALLOWED_ORIGIN=https://seu-dominio.com
NODE_ENV=production
```

### 3. Build

```bash
npm run build:all
```

### 4. Iniciar Serviços

#### Desenvolvimento:
```bash
npm run dev
```

#### Produção:
```bash
# Terminal 1: Backend
cd backend && npm run start:prod

# Terminal 2: Frontend (servir dist/ com nginx/caddy)
npx serve dist -p 5173

# Terminal 3: TTS Server
cd backend && python ttsServer.py
```

### 5. Verificar Health

```bash
curl http://localhost:3001/health
```

## Deploy com Docker

```bash
docker-compose up -d
```

## Monitoramento

- Health: `http://localhost:3001/health`
- Metrics: `http://localhost:3001/metrics`
- Logs: `tail -f backend/logs/app.log`

## Troubleshooting

### WhatsApp não conecta
```bash
cd backend
npm run clear-session
```

### Processos zombie do Chrome
```bash
cd backend
npm run kill-browsers
```

### Diagnosticar sistema
```bash
cd backend
npm run diagnose
```
```

---

### 5.2 Atualizar README.md

**Adicionar seção de produção:**
```markdown
## 🔒 Segurança para Produção

### Checklist Pré-Deploy

- [ ] Configurar `ALLOWED_ORIGIN` com domínio real
- [ ] Gerar e configurar `ADMIN_SECRET` forte
- [ ] Remover `.env` do repositório (já em .gitignore)
- [ ] Configurar HTTPS no reverse proxy
- [ ] Habilitar firewall (permitir apenas portas necessárias)
- [ ] Configurar backup automático do Redis
- [ ] Configurar alertas de monitoramento
- [ ] Revisar logs para dados sensíveis
- [ ] Testar rate limiting
- [ ] Verificar permissões de arquivos

### Hardening

```bash
# Configurar fail2ban
sudo apt install fail2ban

# Configurar firewall
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 22/tcp
sudo ufw enable
```
```

---

## 📊 FASE 6: TESTES E VALIDAÇÃO

### 6.1 Criar Testes Básicos

**Criar:** `backend/tests/health.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import axios from 'axios';

const BASE_URL = 'http://localhost:3001';

describe('Health Checks', () => {
  it('should return 200 on /health', async () => {
    const response = await axios.get(`${BASE_URL}/health`);
    expect(response.status).toBe(200);
    expect(response.data.status).toBe('ok');
  });
  
  it('should include services status', async () => {
    const response = await axios.get(`${BASE_URL}/health`);
    expect(response.data.services).toBeDefined();
    expect(response.data.services.redis).toBeDefined();
  });
});

describe('Rate Limiting', () => {
  it('should rate limit excessive requests', async () => {
    const requests = [];
    for (let i = 0; i < 150; i++) {
      requests.push(axios.get(`${BASE_URL}/health`).catch(e => e.response));
    }
    
    const responses = await Promise.all(requests);
    const rateLimited = responses.some(r => r.status === 429);
    expect(rateLimited).toBe(true);
  });
});
```

**Instalar vitest:**
```bash
cd backend
npm install -D vitest
```

**Adicionar script:**
```json
{
  "scripts": {
    "test": "vitest"
  }
}
```

---

### 6.2 Script de Validação Pré-Deploy

**Criar:** `scripts/pre-deploy-check.sh`
```bash
#!/bin/bash

echo "🔍 Verificação Pré-Deploy"
echo "========================"

# Verificar .env
if [ ! -f backend/.env ]; then
  echo "❌ backend/.env não encontrado"
  exit 1
fi

# Verificar variáveis críticas
if ! grep -q "NVIDIA_API_KEY=nvapi-" backend/.env; then
  echo "⚠️  NVIDIA_API_KEY não configurado"
fi

if ! grep -q "ADMIN_SECRET=" backend/.env || grep -q "ADMIN_SECRET=$" backend/.env; then
  echo "❌ ADMIN_SECRET não configurado"
  exit 1
fi

if grep -q "NODE_ENV=development" backend/.env; then
  echo "⚠️  NODE_ENV está em development"
fi

# Build
echo "\n🔨 Build..."
npm run build:all
if [ $? -ne 0 ]; then
  echo "❌ Build falhou"
  exit 1
fi

# Type check
echo "\n🔍 Type check..."
cd backend && npm run typecheck
if [ $? -ne 0 ]; then
  echo "❌ Type check falhou"
  exit 1
fi

cd ..

# Verificar Redis
echo "\n🔌 Verificando Redis..."
if ! redis-cli ping > /dev/null 2>&1; then
  echo "⚠️  Redis não está rodando"
fi

echo "\n✅ Verificação concluída!"
echo "\n📋 Próximos passos:"
echo "1. Revisar logs de segurança"
echo "2. Configurar HTTPS no reverse proxy"
echo "3. Configurar backup do Redis"
echo "4. Testar em ambiente de staging"
echo "5. Configurar monitoramento"
```

**Tornar executável:**
```bash
chmod +x scripts/pre-deploy-check.sh
```

---

## 🎯 RESUMO DE IMPLEMENTAÇÃO

### Prioridade IMEDIATA (Esta Semana)

1. ✅ **Correções Críticas de Segurança** (1-2 dias)
   - Mascarar QR codes em logs
   - Corrigir command injection
   - Adicionar input validation
   - Corrigir auth bypass
   - Implementar mutexes

2. ✅ **Memory Leaks** (1 dia)
   - Cleanup de caches
   - LRU cache implementation
   - Rate limiter cleanup

### Próximas 2 Semanas

3. ✅ **Circuit Breakers e Resiliência** (2-3 dias)
   - Implementar circuit breakers
   - Adicionar retry logic
   - Health checks completos

4. ✅ **Atualizar Dependências** (1-2 dias)
   - Atualizar pacotes compatíveis
   - Testar breaking changes
   - Verificar compatibilidade

5. ✅ **Monitoramento** (2 dias)
   - Metrics endpoint
   - Performance monitoring
   - Audit logging

### Próximo Mês

6. ✅ **Containerização** (2-3 dias)
   - Dockerfile
   - Docker Compose
   - Testes de deploy

7. ✅ **Testes** (3-4 dias)
   - Unit tests críticos
   - Integration tests
   - Load testing

8. ✅ **Documentação** (2 dias)
   - Guia de deploy
   - Runbook de operações
   - Troubleshooting guide

---

## 📈 MÉTRICAS DE SUCESSO

### Antes
- 🔴 13 vulnerabilidades críticas
- 🟠 23 problemas de alta severidade
- ⚠️ Memory leaks identificados
- ⚠️ 36 dependências desatualizadas

### Depois (Meta)
- ✅ 0 vulnerabilidades críticas
- ✅ Memory leaks corrigidos
- ✅ Dependências atualizadas
- ✅ Circuit breakers implementados
- ✅ Monitoramento ativo
- ✅ Health checks robustos
- ✅ Documentação completa
- ✅ Testes automatizados

---

## 🔗 RECURSOS ADICIONAIS

- [OWASP Top 10](https://owasp.org/Top10/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [Redis Best Practices](https://redis.io/docs/management/optimization/)
- [Puppeteer Best Practices](https://pptr.dev/guides/best-practices)

---

## ✅ CORREÇÕES APLICADAS (07/10/2026)

Todas as correções críticas abaixo foram **implementadas e verificadas** (typecheck + build + smoke tests):

| # | Correção | Arquivo(s) |
|---|----------|------------|
| 1 | QR Code não é mais logado (apenas tamanho) | `WhatsAppService.ts` |
| 2 | `execSync` com timeout em kill de browsers | `WhatsAppService.ts` |
| 3 | Cleanup periódico de caches (chats + contatos) | `WhatsAppService.ts` |
| 4 | Sanitização de input anti prompt-injection + limite de tamanho | `AIService.ts` |
| 5 | Retry com exponencial backoff + timeout reduzido (30s) | `AIService.ts` |
| 6 | Leitura assíncrona de arquivo + validação anti path-traversal + cleanup de temp | `TTSService.ts` |
| 7 | Mutex no browser compartilhado + close seguro | `PaymobiScraperService.ts` |
| 8 | Mascaramento de CPF/CNPJ/IMEI em logs (LGPD) | `PaymobiScraperService.ts` |
| 9 | Rate limiter com cleanup periódico (sem memory leak) | `SocketController.ts` |
| 10 | Auth fail-closed no `restart-whatsapp` (exige `ADMIN_SECRET`) | `SocketController.ts` |
| 11 | Validação Zod de todos os payloads de socket + handlers async seguros | `SocketController.ts` |
| 12 | LRU cache limitado (2000 entradas, TTL 24h) + IDs validados + WATCH/MULTI atômico + SCAN | `ChatStateService.ts` |
| 13 | Incrementos atômicos (WATCH/MULTI/EXEC) + limite de intents + parse seguro | `AnalyticsService.ts` |
| 14 | Rate limiting HTTP global + body limit 1MB + buffer socket 25MB | `server.ts` |
| 15 | Health check com services/memória + graceful shutdown com timeout + close de browser/Redis | `server.ts`, `useSocket.ts` (token admin), `QRCodeScreen.tsx` (lint) |

**Notas de operação:**
- `restart-whatsapp` agora exige `ADMIN_SECRET` configurado no backend **e** token no cliente.
- Token do frontend: `VITE_ADMIN_TOKEN` ou `localStorage.setItem('athina_admin_token', '<ADMIN_SECRET>')`.
- Novas dependências: `async-mutex`, `lru-cache`, `express-rate-limit`.

---

**Última atualização:** 07/10/2026  
**Versão do documento:** 1.1
