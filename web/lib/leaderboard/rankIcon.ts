import type { Band } from "@/lib/supabase/types";

// "Prism" isn't a value of the Band union (it's a live top-N overlay on top of a real band —
// see CLAUDE.md, "Bands / ranks") but callers resolve `is_prism ? "Prism" : band` before
// reaching these, so the icon/label functions accept the wider display-only type.
export type DisplayBand = Band | "Prism";

export function getRankIconPath(band: DisplayBand | null): string {
  if (!band) return "/ranks/Unranked.png";
  return `/ranks/${band}.png`;
}

export function getRankLabel(band: DisplayBand | null): string {
  if (!band) return "Unranked";
  return band;
}
