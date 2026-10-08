/**
 * @fileoverview Utility script to clear corrupted WhatsApp session.
 * Run this if the QR code is not loading or WhatsApp fails to connect.
 *
 * Usage: npx tsx src/utils/clearSession.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUTH_PATH = path.resolve(__dirname, '../../.wwebjs_auth');
const CACHE_PATH = path.resolve(__dirname, '../../.wwebjs_cache');

console.log('🧹 WhatsApp Session Cleaner');
console.log('===========================\n');

function removeDirectory(dirPath: string): boolean {
  if (!fs.existsSync(dirPath)) {
    console.log(`  ⏭️  ${path.basename(dirPath)} não encontrado (OK)`);
    return false;
  }

  try {
    // Count files before removal
    let fileCount = 0;
    const countFiles = (dir: string) => {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        if (fs.statSync(filePath).isDirectory()) {
          countFiles(filePath);
        } else {
          fileCount++;
        }
      }
    };
    countFiles(dirPath);

    fs.rmSync(dirPath, { recursive: true, force: true });
    console.log(`  ✅ ${path.basename(dirPath)} removido (${fileCount} arquivos)`);
    return true;
  } catch (err) {
    console.error(`  ❌ Erro ao remover ${path.basename(dirPath)}:`, err);
    return false;
  }
}

// Main cleanup
console.log('📂 Procurando sessões...\n');

const authRemoved = removeDirectory(AUTH_PATH);
const cacheRemoved = removeDirectory(CACHE_PATH);

console.log('\n📋 Resultado:');
if (authRemoved || cacheRemoved) {
  console.log('  ✅ Sessão limpa com sucesso!');
  console.log('  🔄 Reinicie o servidor para gerar um novo QR Code.');
} else {
  console.log('  ℹ️  Nenhuma sessão encontrada para limpar.');
}

console.log('\n💡 Dica: Se o problema persistir, verifique se o Chromium');
console.log('   não está bloqueado por um firewall ou antivírus.\n');
