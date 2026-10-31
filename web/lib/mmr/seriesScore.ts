import type { SeriesLength, Team } from "@/lib/supabase/types";

// Series-score reporting (/admin report-mode mode:score) — pure, kept out of report.ts so the
// validation and the margin multiplier can be unit tested without Discord/database code.

export const SERIES_LENGTH_GAMES: Record<SeriesLength, number> = { bo3: 3, bo5: 5, bo7: 7 };

// A null series_length means the series-length vote was off for that series. Score validation
// and the margin multiplier both treat it as a Best of 5 — the length the community plays by
// default, and the one whose 1.0x K multiplier a null length already implies.
export function seriesGameCount(seriesLength: SeriesLength | null): number {
  return SERIES_LENGTH_GAMES[seriesLength ?? "bo5"];
}

export function gamesToWin(seriesGames: number): number {
  return Math.ceil(seriesGames / 2);
}

export type SeriesScoreValidation =
  | { ok: true; reporterWon: boolean; winnerGames: number; loserGames: number }
  | { ok: false; error: string };

// The winner must have exactly the clinching number of games and the loser strictly fewer —
// a 2-1 in a Best of 5 (not finished) or 4-2 in a Best of 5 (impossible) is rejected rather
// than guessed at. That also keeps |a-b| within 1..ceil(s/2), the range the margin formula
// below is defined over.
export function validateSeriesScore(myGames: number, opponentGames: number, seriesLength: SeriesLength | null): SeriesScoreValidation {
  const s = seriesGameCount(seriesLength);
  const w = gamesToWin(s);
  const example = `${w}-${Math.max(0, w - 2)}`;
  const rule = `In a Best of ${s}, the winning team has exactly ${w} game${w === 1 ? "" : "s"} and the losing team fewer (e.g. ${example}).`;
  if (!Number.isInteger(myGames) || !Number.isInteger(opponentGames) || myGames < 0 || opponentGames < 0) {
    return { ok: false, error: `Games won must be whole numbers, 0 or more. ${rule}` };
  }
  const winnerGames = Math.max(myGames, opponentGames);
  const loserGames = Math.min(myGames, opponentGames);
  if (winnerGames !== w || loserGames >= w) {
    return { ok: false, error: `${myGames}-${opponentGames} isn't a finished series score. ${rule}` };
  }
  return { ok: true, reporterWon: myGames > opponentGames, winnerGames, loserGames };
}

// g = 1 - s/10 + 6s|a-b| / (35 ceil(s/2)), linear in the margin. A sweep pays more than 1x and
// the closest score less (BO3 2-0 1.214 / 2-1 0.957; BO5 3-0 1.357 / 3-1 1.071 / 3-2 0.786;
// BO7 4-0 1.5 / 4-1 1.2 / 4-2 0.9 / 4-3 0.6).
export function computeScoreMarginMultiplier(seriesGames: number, winnerGames: number, loserGames: number): number {
  const w = gamesToWin(seriesGames);
  return 1 - seriesGames / 10 + (6 * seriesGames * Math.abs(winnerGames - loserGames)) / (35 * w);
}

// A reported (or proposed) series result. Games are winner-relative, like the series row's
// winner_games/loser_games, and null when the result carries no score (win/loss mode).
export type SeriesResult = { winner: Team; winnerGames: number | null; loserGames: number | null };

export function sameSeriesResult(a: SeriesResult, b: SeriesResult): boolean {
  return a.winner === b.winner && a.winnerGames === b.winnerGames && a.loserGames === b.loserGames;
}

// A plain flip (win/loss-mode /correct, or /admin correct-report with only winner:) — the other
// team wins and any stored score's margin carries over unchanged, so a 3-1 for A becomes a 3-1
// for B.
export function flippedSeriesResult(current: SeriesResult): SeriesResult {
  return { ...current, winner: current.winner === "A" ? "B" : "A" };
}

// "Team B 3–2", or just "Team B" for a result with no score — the wording /correct's vote
// progress and confirmations use.
export function formatSeriesResult(result: SeriesResult): string {
  const score = result.winnerGames !== null && result.loserGames !== null ? ` ${result.winnerGames}–${result.loserGames}` : "";
  return `Team ${result.winner}${score}`;
}

// The score_multiplier for a result's score, or the 1x no-op for a result with none.
export function seriesResultMultiplier(result: SeriesResult, seriesLength: SeriesLength | null): number {
  if (result.winnerGames === null || result.loserGames === null) return 1;
  return computeScoreMarginMultiplier(seriesGameCount(seriesLength), result.winnerGames, result.loserGames);
}

// Whether a correction changes the score itself, not just who won. Only then is score_multiplier
// recomputed (and the score columns written); a flip keeps the report-time snapshot, so a later
// formula change never retroactively reprices a match that was only flipped.
export function seriesScoreChanged(from: SeriesResult, to: SeriesResult): boolean {
  return from.winnerGames !== to.winnerGames || from.loserGames !== to.loserGames;
}
