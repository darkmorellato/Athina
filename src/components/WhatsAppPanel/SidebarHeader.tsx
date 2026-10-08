/**
 * @fileoverview Chat sidebar header component.
 */

export function SidebarHeader() {
  return (
    <div className="p-4 bg-[#f0f2f5] border-b border-gray-200 flex items-center gap-3">
      <div className="w-10 h-10 bg-emerald-500 rounded-full flex items-center
        justify-center text-white shadow-xs font-bold">
        N
      </div>
      <div className="flex flex-col">
        <span className="text-xs font-bold text-gray-800">Nuovopay Bot</span>
        <span className="text-[10px] text-emerald-500 font-bold flex items-center gap-1">
          <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
          Online
        </span>
      </div>
    </div>
  );
}