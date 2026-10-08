/**
 * E2E do painel (visual WhatsApp Web).
 *
 * IMPORTANTE: nada aqui ENVIA mensagens ao WhatsApp — os testes ficam
 * restritos a carregar, navegar e digitar (sem submeter).
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Seleciona o primeiro contato da sidebar com RETRY: a lista chega em dois
 * lotes (parcial e completo — ~6k conversas) e o primeiro clique pode cair
 * no meio do re-render. O `toPass` repete o par clique→assert até colar.
 */
async function selectFirstContact(page: Page): Promise<void> {
  const firstContact = page.locator('div.cursor-pointer').first();
  await expect(firstContact).toBeVisible({ timeout: 20_000 });
  await expect(async () => {
    await firstContact.click();
    await expect(page.locator('.wa-composer')).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
}

test('painel carrega com sidebar, conversa e composer', async ({ page }) => {
  await page.goto('/');
  await selectFirstContact(page);
  await expect(page.locator('.wa-chat')).toBeVisible();
});

test('navega entre as abas (Chats / Treinamento / Métricas)', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Treinamento' }).click();
  await expect(page.getByText('Diretrizes & Regras de Conduta')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Métricas' }).click();
  await expect(page.getByText('Total de Conversas')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Chats' }).click();
  await expect(page.locator('div.cursor-pointer').first()).toBeVisible({ timeout: 10_000 });
});

test('digita no composer sem enviar (nada sai para o cliente)', async ({ page }) => {
  await page.goto('/');
  await selectFirstContact(page);

  const input = page.getByPlaceholder('Digite uma mensagem');
  await input.fill('teste e2e — não enviar');
  await expect(input).toHaveValue('teste e2e — não enviar');

  // Limpa o campo sem submeter (o botão de enviar NÃO é clicado)
  await input.fill('');
  await expect(input).toHaveValue('');
});
