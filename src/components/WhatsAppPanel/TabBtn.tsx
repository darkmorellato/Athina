import React from 'react';

interface TabBtnProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  color: 'emerald' | 'indigo' | 'violet';
  onClick: () => void;
}

export function TabBtn({ icon, label, active, color, onClick }: TabBtnProps) {
  const cls = active
    ? color === 'emerald' ? 'bg-emerald-500 text-white shadow-xs'
      : color === 'indigo' ? 'bg-indigo-600 text-white shadow-xs'
      : 'bg-violet-600 text-white shadow-xs'
    : 'text-gray-600 hover:bg-white';
  return (
    <button onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl
        text-[10px] md:text-[11px] font-extrabold uppercase tracking-wider transition-all ${cls}`}>
      {icon} {label}
    </button>
  );
}
