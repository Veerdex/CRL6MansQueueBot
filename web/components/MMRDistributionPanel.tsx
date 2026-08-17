"use client";

import { useMemo, useState } from "react";
import BarChart from "./BarChart";
import { BAND_ORDER } from "@/lib/leaderboard/stats";
import { getRankIconPath, getRankLabel } from "@/lib/leaderboard/rankIcon";
import type { MMRDistributionPlayer } from "@/lib/leaderboard/queries";

interface MMRDistributionPanelProps {
  players: MMRDistributionPlayer[];
  totalMatchesPlayed: number;
  rankMatchesPlayed: number;
  universalMatchesPlayed: number;
  mmrScale: number;
  mmrShift: number;
}

const DEFAULT_DENSITY = 10;
const MIN_DENSITY = 10;
const MAX_DENSITY = 50;

function applyTransform(mmr: number, scale: number, shift: number): number {
  return mmr * scale + shift;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export default function MMRDistributionPanel({
  players,
  totalMatchesPlayed,
  rankMatchesPlayed,
  universalMatchesPlayed,
  mmrScale,
  mmrShift,
}: MMRDistributionPanelProps) {
  // Slider bounds are derived from the live config values so the current setting always sits
  // somewhere on the slider, rather than a fixed range that could silently clip it.
  const [scale, setScale] = useState(mmrScale);
  const [shift, setShift] = useState(mmrShift);
  const scaleMin = Math.min(0.1, mmrScale - 2);
  const scaleMax = Math.max(5, mmrScale + 2);
  const shiftMin = Math.min(-500, mmrShift - 500);
  const shiftMax = Math.max(500, mmrShift + 500);
  // Unlike scale/shift, this changes the actual bin boundaries/count below, not just the printed
  // labels — a display density preference, not a preview of a server config value.
  const [density, setDensity] = useState(DEFAULT_DENSITY);

  // Universal-only players sit at exactly MMR 0 forever (Universal never moves MMR) — including
  // them in the histogram would produce a fake spike at zero, so the charted population is
  // Rank-Queue participants only. Per-band counts below use the full eligible set instead, since
  // Unranked players are honestly part of that breakdown.
  const rankPlayers = useMemo(() => players.filter((p) => p.rankGamesPlayed >= 1), [players]);

  // Bin edges/counts are computed from raw MMR alone and never depend on scale/shift — the
  // transform is a monotonic linear display mapping, so it never changes which players group
  // together, only what number is printed on the axis. This keeps the bars fixed while the
  // sliders move, which is what makes the preview honest.
  const { counts, binMin, binWidth, rawMin, rawMax, rawAvg, rawMedian } = useMemo(() => {
    const raw = rankPlayers.map((p) => p.mmr).sort((a, b) => a - b);
    if (raw.length === 0) {
      return { counts: Array(density).fill(0) as number[], binMin: 0, binWidth: 1, rawMin: 0, rawMax: 0, rawAvg: 0, rawMedian: 0 };
    }
    const min = raw[0];
    const max = raw[raw.length - 1];
    const width = max > min ? (max - min) / density : 1;
    const bins = Array(density).fill(0) as number[];
    for (const mmr of raw) {
      const idx = width > 0 ? Math.min(density - 1, Math.floor((mmr - min) / width)) : 0;
      bins[idx] += 1;
    }
    const sum = raw.reduce((a, b) => a + b, 0);
    return { counts: bins, binMin: min, binWidth: width, rawMin: min, rawMax: max, rawAvg: sum / raw.length, rawMedian: median(raw) };
  }, [rankPlayers, density]);

  // Only the labels (and the derived stats readouts below) depend on the sliders.
  const bars = useMemo(() => {
    return counts.map((count, i) => {
      const rawLo = binMin + i * binWidth;
      const rawHi = rawLo + binWidth;
      const lo = Math.round(applyTransform(rawLo, scale, shift));
      const hi = Math.round(applyTransform(rawHi, scale, shift));
      return { label: `${lo}–${hi}`, value: count };
    });
  }, [counts, binMin, binWidth, scale, shift]);

  const bandCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of players) {
      const key = p.isPrism ? "Prism" : p.isPlaced && p.band ? p.band : "Unranked";
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [players]);

  return (
    <div>
      <h2 className="mb-1 text-lg font-bold text-foreground">MMR Distribution</h2>
      <p className="mb-4 text-sm text-muted">
        Rank Queue players only (Universal Queue never moves MMR). The <code>mmr_scale</code>/<code>mmr_shift</code> sliders
        below only preview how the displayed numbers would read under a different value; nothing is written. Density just
        changes how finely the same players are grouped into bars.
      </p>

      {rankPlayers.length === 0 ? (
        <p className="mb-4 text-sm text-muted">No Rank Queue players yet.</p>
      ) : (
        <BarChart bars={bars} connected maxLabels={DEFAULT_DENSITY} />
      )}

      <div className="mt-4">
        <label className="block text-xs text-muted">
          <div className="mb-1 flex items-center justify-between">
            <span>density</span>
            <span className="font-semibold text-foreground">{density} bars</span>
          </div>
          <input
            type="range"
            min={MIN_DENSITY}
            max={MAX_DENSITY}
            step={1}
            value={density}
            onChange={(e) => setDensity(Number(e.target.value))}
            className="h-1.5 w-full cursor-pointer accent-accent"
            aria-label="Histogram density (bar count)"
          />
        </label>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block text-xs text-muted">
          <div className="mb-1 flex items-center justify-between">
            <span>mmr_scale</span>
            <span className="font-semibold text-foreground">
              {scale.toFixed(2)} <span className="text-muted">(current: {mmrScale})</span>
            </span>
          </div>
          <input
            type="range"
            min={scaleMin}
            max={scaleMax}
            step={0.05}
            value={scale}
            onChange={(e) => setScale(Number(e.target.value))}
            className="h-1.5 w-full cursor-pointer accent-accent"
            aria-label="Preview mmr_scale"
          />
        </label>
        <label className="block text-xs text-muted">
          <div className="mb-1 flex items-center justify-between">
            <span>mmr_shift</span>
            <span className="font-semibold text-foreground">
              {shift.toFixed(0)} <span className="text-muted">(current: {mmrShift})</span>
            </span>
          </div>
          <input
            type="range"
            min={shiftMin}
            max={shiftMax}
            step={5}
            value={shift}
            onChange={(e) => setShift(Number(e.target.value))}
            className="h-1.5 w-full cursor-pointer accent-accent"
            aria-label="Preview mmr_shift"
          />
        </label>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total Matches" value={totalMatchesPlayed} />
        <StatCard label="Rank Matches" value={rankMatchesPlayed} />
        <StatCard label="Universal Matches" value={universalMatchesPlayed} />
        <StatCard label="Rank Players" value={rankPlayers.length} />
        <StatCard label="Average MMR" value={Math.round(applyTransform(rawAvg, scale, shift))} />
        <StatCard label="Median MMR" value={Math.round(applyTransform(rawMedian, scale, shift))} />
        <StatCard label="Min MMR" value={Math.round(applyTransform(rawMin, scale, shift))} />
        <StatCard label="Max MMR" value={Math.round(applyTransform(rawMax, scale, shift))} />
      </div>

      <div className="mt-4">
        <div className="mb-2 text-xs font-semibold text-muted">Players per band</div>
        <div className="flex flex-wrap gap-3">
          {[...BAND_ORDER, "Prism" as const, "Unranked" as const].map((band) => (
            <div key={band} className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-2/50 px-2.5 py-1.5">
              <img src={getRankIconPath(band === "Unranked" ? null : band)} alt={getRankLabel(band === "Unranked" ? null : band)} className="h-4 w-4" />
              <span className="text-xs text-foreground">{band}</span>
              <span className="text-xs font-semibold text-muted">{bandCounts.get(band) ?? 0}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2/50 p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-lg font-bold text-foreground">{value.toLocaleString()}</div>
    </div>
  );
}
