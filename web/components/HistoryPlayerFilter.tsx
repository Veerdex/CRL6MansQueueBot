"use client";

import { useMemo, useState } from "react";
import { playTap } from "@/lib/sound";

export interface HistoryPlayerOption {
  playerId: string;
  displayName: string;
}

const MAX_RESULTS = 50;

// Distinct from SearchBar.tsx (which only highlights/scrolls a table row) — this is a proper
// filter: picking a player narrows the match list down to matches they were part of. A plain
// text input doubles as the dropdown's own filter box rather than adding a separate <select>,
// since the player list can grow past what a native <select> comfortably browses.
export default function HistoryPlayerFilter({
  players,
  selectedPlayerId,
  onSelect,
}: {
  players: HistoryPlayerOption[];
  selectedPlayerId: string | null;
  onSelect: (playerId: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const selected = players.find((p) => p.playerId === selectedPlayerId) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? players.filter((p) => p.displayName.toLowerCase().includes(q)) : players;
    return [...list].sort((a, b) => a.displayName.localeCompare(b.displayName)).slice(0, MAX_RESULTS);
  }, [players, query]);

  function pick(playerId: string | null) {
    playTap();
    onSelect(playerId);
    setQuery("");
    setOpen(false);
  }

  return (
    <div className="relative w-full max-w-sm">
      <input
        type="text"
        placeholder={selected ? selected.displayName : "Filter by player..."}
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="field w-full px-3 py-2 text-sm text-foreground placeholder:text-muted"
      />
      {selected && !open && (
        <button
          type="button"
          onClick={() => pick(null)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted transition-colors hover:text-foreground"
        >
          ✕
        </button>
      )}
      {open && (
        <div className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-border bg-surface shadow-lg">
          {selected && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(null)}
              className="block w-full px-3 py-2 text-left text-sm text-muted hover:bg-surface-2"
            >
              Show all players
            </button>
          )}
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted">No players found.</div>
          ) : (
            filtered.map((p) => (
              <button
                key={p.playerId}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(p.playerId)}
                className="block w-full px-3 py-2 text-left text-sm text-foreground hover:bg-surface-2"
              >
                {p.displayName}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
