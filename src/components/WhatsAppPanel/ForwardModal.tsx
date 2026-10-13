import { useMemo, useState } from 'react';
import { Forward, Search, X } from 'lucide-react';
import type { Contact } from '../../types/index.js';

interface ForwardModalProps {
  contacts: Contact[];
  onPick: (contactId: string) => void;
  onClose: () => void;
}

/** Escolhe o chat de destino para encaminhar uma mensagem (como no WhatsApp Web). */
export function ForwardModal({ contacts, onPick, onClose }: ForwardModalProps) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    return q ? contacts.filter((c) => c.name.toLowerCase().includes(q) || c.id.includes(q)) : contacts;
  }, [contacts, query]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Encaminhar mensagem"
        className="bg-white rounded-xl shadow-xl w-[360px] max-h-[70vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <span className="flex items-center gap-2 font-semibold text-sm text-gray-800">
            <Forward size={14} /> Encaminhar para
          </span>
          <button type="button" onClick={onClose} aria-label="Fechar" className="text-gray-400 hover:text-gray-700">
            <X size={16} />
          </button>
        </div>
        <div className="px-4 py-2 relative">
          <Search className="absolute left-7 top-4 text-gray-400" size={12} />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar conversa"
            className="w-full pl-7 pr-3 py-1.5 rounded-lg text-xs border border-gray-300 focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
          />
        </div>
        <ul className="overflow-y-auto custom-scrollbar flex-1 pb-2">
          {filtered.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onPick(c.id)}
                className="w-full text-left px-4 py-2.5 hover:bg-gray-50 flex flex-col"
              >
                <span className="text-sm font-medium text-gray-900 truncate">{c.name}</span>
                <span className="text-[11px] text-gray-400 truncate">{c.id.split('@')[0]}</span>
              </button>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="px-4 py-6 text-center text-xs text-gray-400">Nenhuma conversa encontrada</li>
          )}
        </ul>
      </div>
    </div>
  );
}
