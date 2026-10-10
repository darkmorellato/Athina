/**
 * Cores de avatar do WhatsApp Web (fallback sem foto) — paleta oficial dos
 * tokens --WDS-components-profile-photo-* (tema claro, extraídos ao vivo).
 */
const AVATAR_COLORS = [
  'bg-[#F4DED1] text-[#855538]', // brown
  'bg-[#D2E8FE] text-[#0063CB]', // cobalt
  'bg-[#EEEEEE] text-[#757778]', // gray
  'bg-[#D9FDD3] text-[#1B8755]', // green
  'bg-[#FEE2D8] text-[#C4532D]', // orange
  'bg-[#FFDAE7] text-[#D42A66]', // pink
  'bg-[#E8E0FF] text-[#5E47DE]', // purple
  'bg-[#FBD8DC] text-[#B80531]', // red
  'bg-[#CAECFA] text-[#027EB5]', // sky blue
  'bg-[#CBF2EE] text-[#028377]', // teal
  'bg-[#FFF0D4] text-[#9D6C2C]', // yellow
];

/** Cor estável por contato (mesma pessoa → sempre a mesma cor). */
export function avatarColorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

// Mesma paleta em hex, para estilo inline (onde classes do Tailwind não
// venceriam o CSS custom .wa-chat-avatar).
const AVATAR_PALETTE_HEX = [
  { bg: '#F4DED1', fg: '#855538' },
  { bg: '#D2E8FE', fg: '#0063CB' },
  { bg: '#EEEEEE', fg: '#757778' },
  { bg: '#D9FDD3', fg: '#1B8755' },
  { bg: '#FEE2D8', fg: '#C4532D' },
  { bg: '#FFDAE7', fg: '#D42A66' },
  { bg: '#E8E0FF', fg: '#5E47DE' },
  { bg: '#FBD8DC', fg: '#B80531' },
  { bg: '#CAECFA', fg: '#027EB5' },
  { bg: '#CBF2EE', fg: '#028377' },
  { bg: '#FFF0D4', fg: '#9D6C2C' },
];

export function avatarPaletteFor(id: string): { bg: string; fg: string } {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_PALETTE_HEX[Math.abs(h) % AVATAR_PALETTE_HEX.length];
}
