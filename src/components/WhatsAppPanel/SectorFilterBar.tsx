/**
 * @fileoverview Sector filter bar for contact list.
 */

type SectorKey = 'all' | 'cobranca' | 'suporte' | 'vendas';

interface SectorFilterBarProps {
  selected: SectorKey;
  onChange: (s: SectorKey) => void;
}

const SECTORS: { key: SectorKey; label: string; activeClass: string }[] = [
  { key: 'all', label: 'Todos', activeClass: 'bg-white text-gray-800 shadow-xs border border-gray-200/50' },
  { key: 'cobranca', label: 'Cob', activeClass: 'bg-white text-emerald-800 shadow-xs border-l-2 border-emerald-500' },
  { key: 'suporte', label: 'Sup', activeClass: 'bg-white text-blue-800 shadow-xs border-l-2 border-blue-500' },
  { key: 'vendas', label: 'Vend', activeClass: 'bg-white text-amber-800 shadow-xs border-l-2 border-amber-500' },
];

export function SectorFilterBar({ selected, onChange }: SectorFilterBarProps) {
  return (
    <div className="flex bg-gray-50 border-b border-gray-200 p-1.5 gap-1 shrink-0">
      {SECTORS.map(({ key, label, activeClass }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`flex-1 py-1 rounded-lg text-[9px] font-extrabold uppercase
            transition-all tracking-wider text-center
            ${selected === key ? activeClass : 'text-gray-500 hover:bg-white/50'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}