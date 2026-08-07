// Hardcoded until the admin config-values phase (CLAUDE.md phase 8) builds a real config table.
export const PLACEMENT_GAMES_REQUIRED = 10;
export const SEASON_RANK_DISPLAY_MIN_GAMES = 10;
export const TOP10_MIN_GAMES = 8;
// Mirrors config.ts's KNOWN_CONFIG_DEFAULTS.prism_top_n fallback — used by the test-data
// generator, which seeds synthetic season_history rows without hitting the DB config table.
export const PRISM_TOP_N = 5;
