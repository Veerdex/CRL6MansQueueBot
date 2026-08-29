import type { Band } from "@/lib/supabase/types";

// Prism is a season-end achievement held additively alongside a player's real band (see
// CLAUDE.md, "Bands / ranks") — it is never a value of the band/icon itself, so this type is
// just an alias for the real Band union.
export type DisplayBand = Band;

export function getRankIconPath(band: DisplayBand | null): string {
  if (!band) return "/ranks/Unranked.png";
  return `/ranks/${band}.png`;
}

export function getRankLabel(band: DisplayBand | null): string {
  if (!band) return "Unranked";
  return band;
}
