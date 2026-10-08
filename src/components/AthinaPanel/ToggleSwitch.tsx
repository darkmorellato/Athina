import { motion } from 'framer-motion';

interface ToggleSwitchProps {
  active: boolean;
  color: string;
  onClick: () => void;
}

export function ToggleSwitch({ active, color, onClick }: ToggleSwitchProps) {
  return (
    <button
      onClick={onClick}
      className={`w-10 h-5 rounded-full relative transition-colors shadow-inner cursor-pointer
        ${active ? color : 'bg-slate-700'}`}
    >
      <motion.div
        animate={{ x: active ? 22 : 2 }}
        className="w-4 h-4 bg-white rounded-full absolute top-0.5 shadow-md pointer-events-none"
      />
    </button>
  );
}
