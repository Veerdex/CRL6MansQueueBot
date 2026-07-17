import type { Band } from "@/lib/supabase/types";

export function getRankIconPath(band: Band | null): string {
  if (!band) return "/ranks/Unranked.png";
  return `/ranks/${band}.png`;
}

export function getRankLabel(band: Band | null): string {
  if (!band) return "Unranked";
  return band;
}
