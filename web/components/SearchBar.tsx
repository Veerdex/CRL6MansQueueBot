"use client";

import { useRef, useState } from "react";
import { playTap } from "@/lib/sound";

export interface SearchBarProps {
  players: Array<{ playerId: string; displayName: string }>;
  onSearch: (playerId: string | null) => void;
}

export default function SearchBar({ players, onSearch }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function handleSearch(value: string) {
    setQuery(value);

    if (!value.trim()) {
      onSearch(null);
      return;
    }

    const normalizedQuery = value.toLowerCase();
    const match = players.find((p) =>
      p.displayName.toLowerCase().includes(normalizedQuery)
    );

    if (match) {
      playTap();
      onSearch(match.playerId);
    }
  }

  function handleClear() {
    setQuery("");
    onSearch(null);
    inputRef.current?.focus();
  }

  return (
    <div className="relative w-full">
      <input
        ref={inputRef}
        type="text"
        placeholder="Search player..."
        value={query}
        onChange={(e) => handleSearch(e.target.value)}
        className="field w-full px-3 py-2 text-sm text-foreground placeholder:text-muted"
      />
      {query && (
        <button
          type="button"
          onClick={handleClear}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted hover:text-foreground transition-colors"
        >
          ✕
        </button>
      )}
    </div>
  );
}
