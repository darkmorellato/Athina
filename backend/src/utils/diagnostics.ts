/**
 * @fileoverview Diagnostic tool for QR Code and Socket.IO connection issues.
 * Run this to check if everything is configured correctly.
 *
 * Usage: npx tsx src/utils/diagnostics.ts
 */
import http from 'http';
import { io as SocketIOClient } from 'socket.io-client';

const BACKEND_PORT = 3001;
const FRONTEND_PORT = 5173;

console.log('🔍 Agent Athina - Connection Diagnostics');
console.log('=========================================\n');

interface CheckResult {
  name: string;
  status: '✅' | '❌' | '⚠️';
  message: string;
}

const results: CheckResult[] = [];

function check(name: string, condition: boolean, message: string): void {
  results.push({
    name,
    status: condition ? '✅' : '❌',
    message,
  });
}

// Test 1: Check if backend is running
function checkBackend(): Promise<void> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${BACKEND_PORT}/health`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const health = JSON.parse(data);
          check('Backend Server', true, `Running on port ${BACKEND_PORT} (uptime: ${Math.round(health.uptime)}s)`);
          check('WhatsApp Status', health.whatsapp !== 'DISCONNECTED', `State: ${health.whatsapp}`);
        } catch {
          check('Backend Server', false, 'Responding but invalid JSON');
        }
        resolve();
      });
    });

    req.on('error', () => {
      check('Backend Server', false, `Not running on port ${BACKEND_PORT}`);
      resolve();
    });

    req.setTimeout(3000, () => {
      check('Backend Server', false, 'Connection timeout');
      req.destroy();
      resolve();
    });
  });
}

// Test 2: Check Socket.IO endpoint
function checkSocketIO(): Promise<void> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${BACKEND_PORT}/socket.io/?EIO=4&transport=polling`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        check('Socket.IO Endpoint', data.includes('sid'), `Polling endpoint responding`);
        resolve();
      });
    });

    req.on('error', () => {
      check('Socket.IO Endpoint', false, 'Not accessible');
      resolve();
    });

    req.setTimeout(3000, () => {
      check('Socket.IO Endpoint', false, 'Timeout');
      req.destroy();
      resolve();
    });
  });
}

// Test 3: Check Socket.IO client connection
function checkSocketConnection(): Promise<void> {
  return new Promise((resolve) => {
    const socket = SocketIOClient(`http://localhost:${BACKEND_PORT}`, {
      transports: ['websocket', 'polling'],
      timeout: 5000,
    });

    const timeout = setTimeout(() => {
      socket.disconnect();
      check('Socket.IO Connection', false, 'Connection timeout (5s)');
      resolve();
    }, 6000);

    socket.on('connect', () => {
      clearTimeout(timeout);
      check('Socket.IO Connection', true, `Connected with ID: ${socket.id}`);
      
      // Request status
      socket.emit('request-status');
      
      setTimeout(() => {
        socket.disconnect();
        resolve();
      }, 2000);
    });

    socket.on('server-status', (status: string) => {
      check('Server Status Event', true, `Received: ${status}`);
    });

    socket.on('whatsapp-qr', (qr: string) => {
      check('QR Code Event', true, `Received QR (${qr.length} chars)`);
    });

    socket.on('whatsapp-ready', () => {
      check('WhatsApp Ready Event', true, 'WhatsApp is ready!');
    });

    socket.on('connect_error', (err: Error) => {
      clearTimeout(timeout);
      check('Socket.IO Connection', false, `Error: ${err.message}`);
      socket.disconnect();
      resolve();
    });
  });
}

// Test 4: Check frontend port
function checkFrontend(): Promise<void> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${FRONTEND_PORT}`, (res) => {
      check('Frontend Server', res.statusCode === 200, `Running on port ${FRONTEND_PORT}`);
      resolve();
    });

    req.on('error', () => {
      check('Frontend Server', false, `Not running on port ${FRONTEND_PORT}`);
      resolve();
    });

    req.setTimeout(3000, () => {
      check('Frontend Server', false, 'Timeout');
      req.destroy();
      resolve();
    });
  });
}

// Run all checks
async function runDiagnostics(): Promise<void> {
  console.log('Running diagnostics...\n');

  await checkBackend();
  await checkSocketIO();
  await checkSocketConnection();
  await checkFrontend();

  // Print results
  console.log('\n📊 Results:');
  console.log('─'.repeat(50));
  
  for (const result of results) {
    console.log(`${result.status} ${result.name}: ${result.message}`);
  }

  console.log('─'.repeat(50));

  // Summary
  const passed = results.filter(r => r.status === '✅').length;
  const failed = results.filter(r => r.status === '❌').length;
  
  console.log(`\n📈 Summary: ${passed} passed, ${failed} failed\n`);

  if (failed > 0) {
    console.log('💡 Troubleshooting tips:');
    console.log('   1. Start backend: cd backend && npm run dev');
    console.log('   2. Start frontend: npm run dev');
    console.log('   3. Check firewall/antivirus blocking connections');
    console.log('   4. Clear session: npm run clean (in backend/)\n');
  }
}

runDiagnostics().catch(console.error);
