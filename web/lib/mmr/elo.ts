import type { Team } from "@/lib/supabase/types";

// Pure Elo engine — no Discord, no DB. See CLAUDE.md, "MMR / Elo": standard Elo, single
// rating per player, team rating = average of the 3 teammates' MMR, points split evenly
// across the team. Provisional K is applied per player (not blended into one team K) since
// each player's own provisional status is what the spec's "elevated K for a player's first
// N Rank Queue games" describes — teammates with different provisional status legitimately
// gain/lose different amounts on the same result.

export type EloPlayerInput = {
  playerId: string;
  mmr: number;
  team: Team;
  priorRankGamesPlayed: number;
};

export type EloConfig = {
  kFactor: number;
  sScale: number;
  provisionalGames: number;
  provisionalKMultiplier: number;
};

export type EloResult = {
  playerId: string;
  delta: number;
  newMmr: number;
  wasProvisional: boolean;
};

function teamAverage(players: EloPlayerInput[], team: Team): number {
  const members = players.filter((p) => p.team === team);
  return members.reduce((sum, p) => sum + p.mmr, 0) / members.length;
}

export function computeEloDeltas(players: EloPlayerInput[], winner: Team, config: EloConfig): EloResult[] {
  const avgA = teamAverage(players, "A");
  const avgB = teamAverage(players, "B");
  const expectedA = 1 / (1 + 10 ** ((avgB - avgA) / config.sScale));
  const expectedByTeam: Record<Team, number> = { A: expectedA, B: 1 - expectedA };

  return players.map((p) => {
    const score = p.team === winner ? 1 : 0;
    const expected = expectedByTeam[p.team];
    const wasProvisional = p.priorRankGamesPlayed < config.provisionalGames;
    const k = wasProvisional ? config.kFactor * config.provisionalKMultiplier : config.kFactor;
    const delta = (k * (score - expected)) / 3;
    return { playerId: p.playerId, delta, newMmr: p.mmr + delta, wasProvisional };
  });
}
