/**
 * @fileoverview Contact list sidebar component.
 * Virtualized (windowing) to handle thousands of contacts smoothly.
 * Acessível por teclado (listbox/option) e com a paleta de avatar do WA.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import type { Contact } from '../types/index.js';
import { avatarColorFor } from './waAvatarColors.js';

const ITEM_HEIGHT = 80;
const OVERSCAN = 6;

interface ContactListProps {
  contacts: Contact[];
  selectedContact: string | null;
  onSelectContact: (id: string) => void;
  /** Muda (ex.: busca) → lista volta ao topo */
  resetScrollKey?: string;
  /** Fotos de perfil (jid → url ou null) */
  avatars?: Record<string, string | null>;
  /** Pede fotos para os jids (só as faltantes são pedidas) */
  onRequestAvatars?: (jids: string[]) => void;
}

export const ContactList = memo(function ContactList({
  contacts,
  selectedContact,
  onSelectContact,
  resetScrollKey,
  avatars = {},
  onRequestAvatars,
}: ContactListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  const rafRef = useRef<number | null>(null);

  const handleScroll = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const el = containerRef.current;
      if (el) setScrollTop(el.scrollTop);
    });
  }, []);

  // Mede a altura visível (ResizeObserver dispara no primeiro observe também)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Volta ao topo quando a busca muda (mutação direta de DOM — sem setState)
  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = 0;
  }, [resetScrollKey]);

  // Virtualização calculada antes dos hooks para manter ordem de hooks estável
  const total = contacts.length;
  const maxStart = Math.max(0, total - Math.ceil(viewportH / ITEM_HEIGHT));
  const rawStart = Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN;
  const start = Math.max(0, Math.min(rawStart, maxStart));
  const end = Math.min(total, Math.ceil((scrollTop + viewportH) / ITEM_HEIGHT) + OVERSCAN);
  const visible = contacts.slice(start, Math.max(end, start + 1));
  const visibleKey = visible.map((c) => c.id).join(',');

  const avatarsRef = useRef(avatars);
  const requestRef = useRef(onRequestAvatars);
  useEffect(() => { avatarsRef.current = avatars; }, [avatars]);
  useEffect(() => { requestRef.current = onRequestAvatars; }, [onRequestAvatars]);

  // Pedido SOB DEMANDA: só os itens visíveis na janela virtualizada (a lista
  // pode ter milhares de contatos — nunca buscamos todos de uma vez).
  useEffect(() => {
    const missing = visible
      .filter((c) => !(c.id in avatarsRef.current))
      .map((c) => c.id);
    if (missing.length > 0) requestRef.current?.(missing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey]);

  if (contacts.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center
        p-8 text-center text-gray-400 gap-2 h-full opacity-50">
        <MessageCircle size={32} />
        <span className="text-xs">Aguardando contatos...</span>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      role="listbox"
      aria-label="Conversas"
      className="flex-1 overflow-y-auto custom-scrollbar relative"
    >
      {start > 0 && <div style={{ height: start * ITEM_HEIGHT }} aria-hidden />}
      {visible.map((c) => (
        <ContactItem
          key={c.id}
          contact={c}
          isSelected={selectedContact === c.id}
          onClick={() => onSelectContact(c.id)}
          avatarUrl={avatars[c.id]}
        />
      ))}
      {end < total && <div style={{ height: (total - end) * ITEM_HEIGHT }} aria-hidden />}
    </div>
  );
});

interface ContactItemProps {
  contact: Contact;
  isSelected: boolean;
  onClick: () => void;
  avatarUrl?: string | null;
}

const ContactItem = memo(function ContactItem({ contact, isSelected, onClick, avatarUrl }: ContactItemProps) {
  // Se a URL da foto falhar ao carregar, volta para a letra (fallback)
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showPhoto = Boolean(avatarUrl) && failedUrl !== avatarUrl;

  // Teclado: Enter/Espaço selecionam (antes só o mouse funcionava)
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <div
      onClick={onClick}
      onKeyDown={handleKeyDown}
      role="option"
      aria-selected={isSelected}
      aria-label={contact.name}
      tabIndex={0}
      style={{ height: ITEM_HEIGHT }}
      className={`flex items-center gap-3 px-4 box-border cursor-pointer hover:bg-gray-50
        border-b border-gray-50 transition-colors overflow-hidden
        focus:outline-hidden focus-visible:bg-[#f0f2f5]
        ${isSelected ? 'bg-[#f0f2f5]' : ''}
        ${contact.isHostile ? 'border-l-4 border-red-500' : ''}`}
    >
      {/* Avatar: foto de perfil do WhatsApp ou letra (fallback com a paleta
          oficial de cores do WA — ver waAvatarColors.ts) */}
      <div className={`w-12 h-12 rounded-full flex items-center justify-center
        font-bold shrink-0 shadow-xs overflow-hidden
        ${contact.isHostile ? 'bg-red-100 text-red-600' : avatarColorFor(contact.id)}`}>
        {showPhoto ? (
          <img
            src={avatarUrl as string}
            alt=""
            loading="lazy"
            className="w-full h-full object-cover"
            onError={() => setFailedUrl(avatarUrl ?? null)}
          />
        ) : (
          contact.name[0]
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex justify-between items-center">
          <h3 className="font-semibold text-gray-900 truncate text-sm flex items-center gap-1.5">
            {contact.name}
            {contact.isHostile && (
              <span className="px-1.5 py-0.5 text-[8px] font-extrabold
                bg-red-500 text-white rounded-full uppercase animate-pulse
                shrink-0 tracking-wide">
                ⚠️ Irritado
              </span>
            )}
          </h3>
          <span className="text-[10px] text-gray-400">{contact.time}</span>
        </div>
        <div className="flex justify-between items-center mt-1">
          <p className={`text-xs truncate max-w-[130px]
            ${contact.isHostile ? 'text-red-500 font-medium' : 'text-gray-500'}`}>
            {contact.lastText}
          </p>
          <span className={`px-1.5 py-0.5 rounded text-[8px] font-extrabold uppercase
            ${contact.sectorColor}`}>
            {contact.sector}
          </span>
        </div>
      </div>
    </div>
  );
});
