/**
 * @fileoverview Quick replies library component for Athina Panel.
 */
import { Trash2 } from 'lucide-react';

interface QuickRepliesListProps {
  quickReplies: string[];
  onDelete: (index: number) => void;
  onSelect: (text: string) => void;
}

export function QuickRepliesList({ quickReplies, onDelete, onSelect }: QuickRepliesListProps) {
  return (
    <div className="grid grid-cols-1 gap-2.5 max-h-[350px] overflow-y-auto
      pr-3 custom-scrollbar p-1">
      {quickReplies.map((reply, i) => (
        <div key={i} className="group relative">
          <button
            onClick={() => onSelect(reply)}
            className="w-full text-left text-[11px] bg-slate-900/30 hover:bg-indigo-500/10
              text-slate-400 hover:text-indigo-200 p-3.5 rounded-2xl border border-slate-800
              hover:border-indigo-500/30 transition-all line-clamp-2 leading-relaxed shadow-xs"
          >
            {reply}
          </button>
          <button
            onClick={() => onDelete(i)}
            className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0
              group-hover:opacity-100 text-red-400/50 hover:text-red-400 p-2
              transition-all hover:bg-red-500/10 rounded-lg"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}