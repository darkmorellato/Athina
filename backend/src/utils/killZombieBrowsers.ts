/**
 * @fileoverview Utility to kill zombie Chromium/Chrome processes.
 * Run this if you see "The browser is already running" error.
 *
 * Usage: npx tsx src/utils/killZombieBrowsers.ts
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUTH_PATH = path.resolve(__dirname, '../../.wwebjs_auth');

console.log('🔍 Chrome/Chromium Zombie Process Cleaner');
console.log('=========================================\n');

function killProcesses(): void {
  const platform = process.platform;

  try {
    if (platform === 'win32') {
      // Windows
      console.log('🪟 Windows: Killing Chrome/Chromium processes...');
      try {
        execSync('taskkill /F /IM chrome.exe /T 2>nul', { stdio: 'ignore' });
        console.log('  ✅ chrome.exe killed');
      } catch { /* process not found is OK */ }

      try {
        execSync('taskkill /F /IM chromium.exe /T 2>nul', { stdio: 'ignore' });
        console.log('  ✅ chromium.exe killed');
      } catch { /* process not found is OK */ }

    } else if (platform === 'darwin') {
      // macOS
      console.log('🍎 macOS: Killing Chrome/Chromium processes...');
      try {
        execSync('pkill -f "Google Chrome" 2>/dev/null || true');
        execSync('pkill -f chromium 2>/dev/null || true');
        console.log('  ✅ Chrome/Chromium processes killed');
      } catch { /* OK */ }

    } else {
      // Linux — only whatsapp-web.js/puppeteer instances (cmdline references
      // the .wwebjs_auth session dir). A broad `pkill -f chrome` would kill
      // the user's own browser too.
      console.log('🐧 Linux: Killing WhatsApp Web Chrome processes...');
      try {
        execSync("pkill -9 -f '\\.wwebjs_auth' 2>/dev/null || true");
        console.log('  ✅ WhatsApp Web Chrome processes killed (user browser preserved)');
      } catch { /* OK */ }
    }
  } catch (err) {
    console.error('  ⚠️ Error killing processes:', err);
  }
}

function cleanSessionFiles(): void {
  console.log('\n📂 Cleaning session lock files...');

  const lockFiles = [
    path.join(AUTH_PATH, 'session', 'SingletonLock'),
    path.join(AUTH_PATH, 'session', 'SingletonSocket'),
    path.join(AUTH_PATH, 'session', 'SingletonCookie'),
  ];

  for (const lockFile of lockFiles) {
    if (fs.existsSync(lockFile)) {
      try {
        fs.unlinkSync(lockFile);
        console.log(`  ✅ Removed: ${path.basename(lockFile)}`);
      } catch {
        console.log(`  ⚠️ Could not remove: ${path.basename(lockFile)}`);
      }
    }
  }

  // Also clean crash dumps
  const crashDir = path.join(AUTH_PATH, 'session', 'Crashpad', 'reports');
  if (fs.existsSync(crashDir)) {
    const files = fs.readdirSync(crashDir);
    for (const file of files) {
      if (file.endsWith('.dmp')) {
        try {
          fs.unlinkSync(path.join(crashDir, file));
          console.log(`  ✅ Removed crash dump: ${file}`);
        } catch { /* OK */ }
      }
    }
  }
}

// Main
killProcesses();
cleanSessionFiles();

console.log('\n✅ Cleanup complete!');
console.log('💡 Now restart the server: npm run dev\n');
