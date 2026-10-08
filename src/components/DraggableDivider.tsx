/**
 * @fileoverview Draggable divider for resizing panels.
 */
import { useRef } from 'react';

interface DraggableDividerProps {
  onResize: (width: number) => void;
}

export function DraggableDivider({ onResize }: DraggableDividerProps) {
  const isResizing = useRef(false);

  const startResizing = () => {
    isResizing.current = true;

    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const newWidth = (e.clientX / window.innerWidth) * 100;
      if (newWidth > 20 && newWidth < 80) onResize(newWidth);
    };

    const stopResizing = () => {
      isResizing.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', stopResizing);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', stopResizing);
  };

  return (
    <div
      onMouseDown={startResizing}
      className="w-1.5 hover:w-2 bg-transparent hover:bg-indigo-500/30
        cursor-col-resize z-50 transition-all relative group flex items-center justify-center"
    >
      <div className="w-0.5 h-8 bg-gray-300 rounded-full
        group-hover:bg-indigo-400 transition-colors" />
    </div>
  );
}