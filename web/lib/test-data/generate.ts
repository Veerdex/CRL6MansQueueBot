import "server-only";
import { createAdminClient } from "../supabase/admin";
import { PLACEMENT_GAMES_REQUIRED, TOP10_MIN_GAMES } from "../leaderboard/constants";
import type { Band, QueueType, SeasonRow, Team } from "../supabase/types";

interface PlayerSeedSpec {
  suffix: string;
  mmr: number | null; // null => unplaced (mmr stored as 0, hidden by the UI until placed)
  band: Band | null;
  previousSeasonGames: number;
  currentSeasonGames: number;
  winRate: number;
}

// 8 placed players (2 per band, spread win rates) + 2 still in placement.
// previousSeasonGames deliberately straddles the 10-game "last season rank"
// display cutoff (some above, some below, one skipped entirely) so both the
// numeric and NA cases show up after seeding.
const PLACED_SPECS: PlayerSeedSpec[] = [
  { suffix: "1", mmr: -350, band: "Iron", previousSeasonGames: 6, currentSeasonGames: 9, winRate: 0.25 },
  { suffix: "2", mmr: -150, band: "Iron", previousSeasonGames: 9, currentSeasonGames: 3, winRate: 0.35 },
  { suffix: "3", mmr: 50, band: "Garnet", previousSeasonGames: 10, currentSeasonGames: 8, winRate: 0.45 },
  { suffix: "4", mmr: 150, band: "Garnet", previousSeasonGames: 11, currentSeasonGames: 0, winRate: 0.5 },
  { suffix: "5", mmr: 350, band: "Emerald", previousSeasonGames: 5, currentSeasonGames: 9, winRate: 0.55 },
  { suffix: "6", mmr: 550, band: "Emerald", previousSeasonGames: 8, currentSeasonGames: 8, winRate: 0.65 },
  { suffix: "7", mmr: 750, band: "Sapphire", previousSeasonGames: 0, currentSeasonGames: 13, winRate: 0.75 },
  { suffix: "8", mmr: 950, band: "Sapphire", previousSeasonGames: 12, currentSeasonGames: 7, winRate: 0.85 },
];

const PLACEMENT_SPECS: PlayerSeedSpec[] = [
  { suffix: "P1", mmr: null, band: null, previousSeasonGames: 0, currentSeasonGames: 3, winRate: 0.5 },
  { suffix: "P2", mmr: null, band: null, previousSeasonGames: 0, currentSeasonGames: 6, winRate: 0.5 },
];

function mulberry32(seed: number) {
  let state = seed | 0;
  return function random() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface GameOutcome {
  queueType: QueueType;
  season: "previous" | "current";
  win: boolean;
}

function buildOutcomes(
  rng: () => number,
  spec: Pick<PlayerSeedSpec, "previousSeasonGames" | "currentSeasonGames" | "winRate">,
): GameOutcome[] {
  const outcomes: GameOutcome[] = [];
  for (let i = 0; i < spec.previousSeasonGames + spec.currentSeasonGames; i++) {
    outcomes.push({
      season: i < spec.previousSeasonGames ? "previous" : "current",
      queueType: rng() < 0.7 ? "rank" : "universal",
      win: rng() < spec.winRate,
    });
  }
  // Guarantee an observable, hand-verifiable finish: the last three games are
  // Rank Queue wins, so every seeded player ends on at least a 3-game streak.
  for (let i = Math.max(0, outcomes.length - 3); i < outcomes.length; i++) {
    outcomes[i].queueType = "rank";
    outcomes[i].win = true;
  }
  return outcomes;
}

async function ensureActiveSeason(
  supabase: ReturnType<typeof createAdminClient>,
): Promise<SeasonRow> {
  const { data: existing, error: findError } = await supabase
    .from("crl6mansqueuebot_seasons")
    .select("*")
    .eq("is_active", true)
    .maybeSingle();
  if (findError) throw findError;
  if (existing) return existing;

  const { data: maxRow, error: maxError } = await supabase
    .from("crl6mansqueuebot_seasons")
    .select("season_number")
    .order("season_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (maxError) throw maxError;

  const { data: created, error: createError } = await supabase
    .from("crl6mansqueuebot_seasons")
    .insert({
      season_number: (maxRow?.season_number ?? 0) + 1,
      start_date: new Date().toISOString().slice(0, 10),
      is_active: true,
    })
    .select("*")
    .single();
  if (createError) throw createError;
  return created;
}

async function ensurePreviousSeason(
  supabase: ReturnType<typeof createAdminClient>,
  currentSeason: SeasonRow,
): Promise<SeasonRow> {
  const targetNumber = currentSeason.season_number - 1;

  const { data: existing, error: findError } = await supabase
    .from("crl6mansqueuebot_seasons")
    .select("*")
    .eq("season_number", targetNumber)
    .maybeSingle();
  if (findError) throw findError;
  if (existing) return existing;

  const currentStart = new Date(currentSeason.start_date);
  const previousStart = new Date(currentStart);
  previousStart.setMonth(previousStart.getMonth() - 1);
  const previousEnd = new Date(currentStart);
  previousEnd.setDate(previousEnd.getDate() - 1);

  const { data: created, error: createError } = await supabase
    .from("crl6mansqueuebot_seasons")
    .insert({
      season_number: targetNumber,
      start_date: previousStart.toISOString().slice(0, 10),
      end_date: previousEnd.toISOString().slice(0, 10),
      is_active: false,
    })
    .select("*")
    .single();
  if (createError) throw createError;
  return created;
}

export async function generateTestData(): Promise<{ playersAdded: number }> {
  const supabase = createAdminClient();

  const currentSeason = await ensureActiveSeason(supabase);
  const previousSeason = await ensurePreviousSeason(supabase, currentSeason);

  const specs = [...PLACED_SPECS, ...PLACEMENT_SPECS];
  const batchId = Date.now().toString(36);
  const rng = mulberry32(Date.now() ^ 0x9e3779b9);

  const plans = specs.map((spec) => ({
    spec,
    outcomes: buildOutcomes(rng, spec),
  }));

  const { data: insertedPlayers, error: playersError } = await supabase
    .from("crl6mansqueuebot_players")
    .insert(
      plans.map(({ spec, outcomes }) => {
        const totalGames = outcomes.length;
        const isPlaced = totalGames >= PLACEMENT_GAMES_REQUIRED;
        return {
          discord_id: `test-${batchId}-${spec.suffix}`,
          display_name: `Test Player ${batchId}-${spec.suffix}`,
          mmr: spec.mmr ?? 0,
          band: isPlaced ? spec.band : null,
          is_placed: isPlaced,
          total_games_played: totalGames,
          is_test_data: true,
        };
      }),
    )
    .select("id, discord_id");
  if (playersError) throw playersError;

  const playerIds = plans.map((_, i) => insertedPlayers[i].id);

  const seriesRows: {
    id: string;
    season_id: string;
    queue_type: QueueType;
    status: "reported";
    winner_team: Team;
    is_test_data: true;
    created_at: string;
    reported_at: string;
  }[] = [];
  const seriesPlayerRows: { series_id: string; player_id: string; team: Team }[] = [];

  const totalOutcomes = plans.reduce((sum, p) => sum + p.outcomes.length, 0);
  let cursorMs = Date.now() - totalOutcomes * 60_000;

  plans.forEach(({ outcomes }, playerIndex) => {
    const playerId = playerIds[playerIndex];

    outcomes.forEach((outcome) => {
      cursorMs += 60_000;
      const timestamp = new Date(cursorMs).toISOString();
      const seasonId = outcome.season === "previous" ? previousSeason.id : currentSeason.id;
      const seriesId = crypto.randomUUID();
      seriesRows.push({
        id: seriesId,
        season_id: seasonId,
        queue_type: outcome.queueType,
        status: "reported",
        winner_team: outcome.win ? "A" : "B",
        is_test_data: true,
        created_at: timestamp,
        reported_at: timestamp,
      });
      seriesPlayerRows.push({ series_id: seriesId, player_id: playerId, team: "A" });
    });
  });

  if (seriesRows.length > 0) {
    const { error: seriesError } = await supabase.from("crl6mansqueuebot_series").insert(seriesRows);
    if (seriesError) throw seriesError;

    const { error: seriesPlayersError } = await supabase
      .from("crl6mansqueuebot_series_players")
      .insert(seriesPlayerRows);
    if (seriesPlayersError) throw seriesPlayersError;
  }

  const seasonHistoryRows = plans
    .map(({ spec }, i) => ({ spec, playerId: playerIds[i] }))
    .filter(({ spec }) => spec.previousSeasonGames >= 1)
    .map(({ spec, playerId }, rankIndex) => ({
      season_id: previousSeason.id,
      player_id: playerId,
      mmr_at_close: (spec.mmr ?? 0) - 100,
      season_games_played: spec.previousSeasonGames,
      season_rank: rankIndex + 1,
      made_top10: spec.previousSeasonGames >= TOP10_MIN_GAMES && rankIndex < 10,
    }));

  if (seasonHistoryRows.length > 0) {
    const { error: historyError } = await supabase
      .from("crl6mansqueuebot_season_history")
      .insert(seasonHistoryRows);
    if (historyError) throw historyError;
  }

  return { playersAdded: insertedPlayers.length };
}

export async function resetTestData(): Promise<void> {
  const supabase = createAdminClient();

  // series must go first: it isn't a child of players (it references seasons),
  // so deleting players alone would leave orphaned test `series` rows behind.
  const { error: seriesError } = await supabase
    .from("crl6mansqueuebot_series")
    .delete()
    .eq("is_test_data", true);
  if (seriesError) throw seriesError;

  const { error: playersError } = await supabase
    .from("crl6mansqueuebot_players")
    .delete()
    .eq("is_test_data", true);
  if (playersError) throw playersError;
}
