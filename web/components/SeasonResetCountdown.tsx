"use client";

import { useEffect, useState } from "react";

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

// Simple gold countdown shown at the top of every page while a season reset is scheduled — see
// CLAUDE.md, "Seasons" / /schedule-reset. `resetAt` comes from the server (layout.tsx reading
// scheduled_season_reset_at) as a plain ISO string or null. Starts at `remaining: null` on both
// server and client so the initial render matches (no hydration mismatch from a time-based
// value) — the real countdown only appears once the client mounts and starts ticking.
export default function SeasonResetCountdown({ resetAt }: { resetAt: string | null }) {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!resetAt) {
      setRemaining(null);
      return;
    }
    const targetMs = new Date(resetAt).getTime();
    const tick = () => setRemaining(targetMs - Date.now());
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [resetAt]);

  if (remaining === null || remaining <= 0) return null;

  return (
    <div className="w-full border-b border-gold/30 bg-gold/10 py-1 text-center text-xs font-semibold text-gold">
      Season reset in {formatRemaining(remaining)}
    </div>
  );
}
