import logger from '../../utils/logger.js';
import { getRecentChats, type ChatHelperContext } from './whatsappChatHelper.js';

export async function syncPhonebookContacts(ctx: ChatHelperContext): Promise<void> {
  if (!ctx.client || ctx.state !== 'READY' || ctx.isSyncingPhonebook) return;
  ctx.setIsSyncingPhonebook(true);
  try {
    logger.info('Starting background phonebook sync...');
    
    const contacts = await ctx.client.getContacts();
    const allContacts = contacts.map((c: any) => ({
      id: {
        _serialized: c.id?._serialized || c.id,
        server: c.id?.server,
        user: c.id?.user
      },
      name: c.name,
      pushname: c.pushname,
      number: c.number || c.id?.user,
      isGroup: c.isGroup || false,
      isMyContact: c.isMyContact || false
    }));

    ctx.setPhonebookContacts(allContacts);
    
    for (const contact of allContacts) {
      const name = contact.name || contact.pushname || contact.number;
      if (name) {
        ctx.contactNameMap.set(contact.id._serialized, name);
      }
    }
    logger.info(`Background phonebook sync completed. ${allContacts.length} contacts synced.`);
    
    ctx.setCachedChats(null);
    ctx.setLastCacheTime(0);

    const chats = await getRecentChats(ctx);
    ctx.emit('chats-loaded', chats);
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Error in background phonebook sync');
  } finally {
    ctx.setIsSyncingPhonebook(false);
  }
}
