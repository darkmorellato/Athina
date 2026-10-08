import { motion } from 'framer-motion';
import { X, BookOpen, Plus } from 'lucide-react';
import { QuickRepliesList } from '../QuickRepliesList.tsx';

interface QuickRepliesModalProps {
  isOpen: boolean;
  onClose: () => void;
  quickReplies: string[];
  newReplyText: string;
  setNewReplyText: (text: string) => void;
  handleAddQuickReply: () => void;
  handleDeleteReply: (idx: number) => void;
  onQuickReplySelect: (text: string) => void;
}

export function QuickRepliesModal({
  isOpen,
  onClose,
  quickReplies,
  newReplyText,
  setNewReplyText,
  handleAddQuickReply,
  handleDeleteReply,
  onQuickReplySelect,
}: QuickRepliesModalProps) {
  if (!isOpen) return null;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className="w-full max-h-[85%] bg-slate-900 border border-slate-800 rounded-3xl p-5 shadow-2xl flex flex-col gap-4 relative overflow-hidden"
    >
      {/* Close Button */}
      <button
        onClick={onClose}
        className="absolute right-4 top-4 p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 rounded-xl transition-all cursor-pointer"
      >
        <X size={16} />
      </button>

      <div className="flex items-center gap-3">
        <div className="p-2 bg-emerald-500/10 rounded-xl">
          <BookOpen size={20} className="text-emerald-400" />
        </div>
        <div>
          <h3 className="font-bold text-sm tracking-tight text-white">Biblioteca Nuovo ({quickReplies.length})</h3>
          <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Respostas Rápidas</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto flex flex-col gap-4 dark-scrollbar pr-1">
        {/* Add Quick Reply Input */}
        <div className="flex flex-col gap-2">
          <label className="text-[10px] uppercase font-bold text-slate-500 tracking-widest select-none">
            Criar Novo Modelo
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={newReplyText}
              onChange={(e) => setNewReplyText(e.target.value)}
              placeholder="Digite o modelo de resposta rápida..."
              className="flex-1 bg-slate-950/60 border border-slate-800 rounded-xl px-4 py-2 text-xs text-indigo-100 focus:outline-hidden focus:border-emerald-500/50"
            />
            <button
              onClick={handleAddQuickReply}
              disabled={!newReplyText.trim()}
              className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-30 disabled:hover:bg-emerald-600 text-white rounded-xl text-xs font-bold transition-all flex items-center gap-1 cursor-pointer"
            >
              <Plus size={14} />
              Adicionar
            </button>
          </div>
        </div>

        <div className="border-t border-slate-800/50 my-2" />

        {/* Quick Replies List */}
        <div className="flex-1 flex flex-col gap-2">
          <div className="flex justify-between items-center mb-1">
            <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider select-none">
              Clique na resposta para enviar
            </span>
          </div>
          <div className="flex-1 min-h-[180px]">
            <QuickRepliesList
              quickReplies={quickReplies}
              onDelete={handleDeleteReply}
              onSelect={(text) => {
                onQuickReplySelect(text);
                onClose();
              }}
            />
          </div>
        </div>
      </div>
    </motion.div>
  );
}
