export type QueueType = "rank";
export type SeriesStatus = "forming" | "active" | "reported" | "cancelled" | "void";
export type Team = "A" | "B";
export type Band = "Iron" | "Garnet" | "Emerald" | "Sapphire";
export type VoteChoice = "balanced" | "captains";
export type SeriesLength = "bo3" | "bo5" | "bo7";

// Row shapes must be `type` aliases, not `interface` — interfaces don't get an
// implicit index signature, so they fail postgrest-js's `Record<string, unknown>`
// constraint on GenericTable and silently resolve query results to `never`.
export type PlayerRow = {
  id: string;
  discord_id: string;
  display_name: string;
  mmr: number;
  peak_mmr: number;
  band: Band | null;
  is_placed: boolean;
  total_games_played: number;
  rank_games_played: number;
  band_games_played: number;
  last_rank_game_at: string | null;
  is_prism: boolean;
  is_test_data: boolean;
  vote_default: VoteChoice | null;
  avatar_url: string | null;
  created_at: string;
  // See migration 0046_role_sync_pending.sql and bands.ts's reconcileMemberRole: true when a
  // Discord role add/remove failed (rate limit, etc.) after band/is_prism already committed here,
  // so the next recomputeBands() run retries the Discord sync even though this player's own
  // band/is_prism didn't change again in the meantime.
  role_sync_pending: boolean;
};

export type SeasonRow = {
  id: string;
  season_number: number;
  start_date: string;
  end_date: string | null;
  is_active: boolean;
};

export type SeriesRow = {
  id: string;
  season_id: string;
  queue_type: QueueType;
  status: SeriesStatus;
  winner_team: Team | null;
  is_test_data: boolean;
  created_at: string;
  reported_at: string | null;
  category_id: string | null;
  queue_channel_id: string | null;
  voice_channel_a_id: string | null;
  voice_channel_b_id: string | null;
  vote_result: VoteChoice | null;
  formation_message_id: string | null;
  bonus_day_multiplier: number;
  teams_formed_at: string | null;
  private_match_password: string | null;
  match_number: number | null;
  series_length: SeriesLength | null;
  series_length_k_multiplier: number;
  vote_started_at: string | null;
  series_length_vote_active: boolean;
  // One-time claim sentinel for /correct's player-vote flip — see migration
  // 0045_correct_votes.sql. Null until a series is flipped via 5-of-6 player vote; once set,
  // /correct refuses to flip that series again. Independent of `status`, which stays "reported".
  correction_claimed_at: string | null;
};

export type SeriesPlayerRow = {
  series_id: string;
  player_id: string;
  team: Team;
  mmr_delta: number;
  // Player's raw mmr immediately before this series was reported — see migration
  // 0032_series_players_mmr_before.sql. Null for series reported before that migration, and
  // callers must fall back to the player's current mmr in that case.
  mmr_before: number | null;
};

export type SeasonHistoryRow = {
  season_id: string;
  player_id: string;
  mmr_at_close: number;
  season_games_played: number;
  season_rank: number;
  made_top10: boolean;
  // The band held at close, snapshotted because the soft reset clears it (see 0049). Null means
  // unplaced at that close — the past-season boards render that as Unranked, exactly as the live
  // board does. Never "Prism": that's the made_top10 overlay above, applied on top of this.
  band_at_close: Band | null;
  // All-time rating points earned for this season's finish (0 for the bottom half of the standing
  // and for every unplaced participant). Summing a player's rows across seasons gives their career
  // all-time rating — see web/lib/mmr/allTimeRating.ts. Nothing reads it yet.
  season_score: number;
};

export type ConfigRow = {
  key: string;
  value: string;
  updated_at: string;
};

export type QueueMemberRow = {
  queue_type: QueueType;
  player_id: string;
  joined_at: string;
};

export type QueueMessageRow = {
  queue_type: QueueType;
  channel_id: string;
  message_id: string | null;
};

export type SeriesLobbyRow = {
  series_id: string;
  player_id: string;
  team: Team | null;
  is_captain: boolean;
};

export type SeriesVoteRow = {
  series_id: string;
  player_id: string;
  choice: VoteChoice;
};

export type SeriesLengthVoteRow = {
  series_id: string;
  player_id: string;
  choice: SeriesLength;
};

export type CancelVoteRow = {
  series_id: string;
  player_id: string;
  voted_at: string;
};

export type CorrectVoteRow = {
  series_id: string;
  player_id: string;
  voted_at: string;
};

export type SubRequestRow = {
  series_id: string;
  leaving_player_id: string;
  nominee_discord_id: string;
  team: Team;
  message_id: string | null;
  created_at: string;
};

export type AbandonVoteRow = {
  series_id: string;
  voter_player_id: string;
  target_player_id: string;
  created_at: string;
};

export type BandRoleKey = Band | "Unranked" | "Prism";

export type BandRoleRow = {
  band: BandRoleKey;
  role_id: string;
  updated_at: string;
};

export type AdminRoleRow = {
  role_id: string;
  added_by: string;
  added_at: string;
};

export type AuditLogRow = {
  id: string;
  actor_discord_id: string;
  action: string;
  target: string | null;
  details: string | null;
  created_at: string;
};

export type TimeOfDayStatsRow = {
  segment_index: number;
  supercharged_count: number;
  non_supercharged_count: number;
};

export type DayOfWeekStatsRow = {
  day_of_week: number;
  count: number;
};

// /mafia mini-game — see CLAUDE.md, "Mafia". Fully independent of PlayerRow: raw Discord ids/
// display names/interaction tokens only, no crl6mansqueuebot_players join anywhere.
export type MafiaGameStatus = "waiting" | "starting" | "started" | "cancelled";

export type MafiaGameRow = {
  id: string;
  channel_id: string;
  guild_id: string;
  message_id: string | null;
  host_discord_id: string;
  status: MafiaGameStatus;
  created_at: string;
  started_at: string | null;
  // Optional lobby access code, set once at creation (register-commands.mjs's password: option)
  // — see migration 0036_mafia_password.sql. Null means the lobby is open to anyone.
  password: string | null;
};

export type MafiaPlayerRow = {
  game_id: string;
  discord_id: string;
  display_name: string;
  interaction_token: string;
  joined_at: string;
};

export type Database = {
  public: {
    Tables: {
      crl6mansqueuebot_players: {
        Row: PlayerRow;
        Insert: Partial<PlayerRow> & Pick<PlayerRow, "discord_id" | "display_name">;
        Update: Partial<PlayerRow>;
        Relationships: [];
      };
      crl6mansqueuebot_seasons: {
        Row: SeasonRow;
        Insert: Partial<SeasonRow> & Pick<SeasonRow, "season_number" | "start_date">;
        Update: Partial<SeasonRow>;
        Relationships: [];
      };
      crl6mansqueuebot_series: {
        Row: SeriesRow;
        Insert: Partial<SeriesRow> & Pick<SeriesRow, "season_id" | "queue_type">;
        Update: Partial<SeriesRow>;
        Relationships: [];
      };
      crl6mansqueuebot_series_players: {
        Row: SeriesPlayerRow;
        Insert: Partial<SeriesPlayerRow> & Pick<SeriesPlayerRow, "series_id" | "player_id" | "team">;
        Update: Partial<SeriesPlayerRow>;
        Relationships: [];
      };
      crl6mansqueuebot_season_history: {
        Row: SeasonHistoryRow;
        Insert: SeasonHistoryRow;
        Update: Partial<SeasonHistoryRow>;
        Relationships: [];
      };
      crl6mansqueuebot_config: {
        Row: ConfigRow;
        Insert: Pick<ConfigRow, "key" | "value">;
        Update: Partial<ConfigRow>;
        Relationships: [];
      };
      crl6mansqueuebot_queue_members: {
        Row: QueueMemberRow;
        Insert: Partial<QueueMemberRow> & Pick<QueueMemberRow, "queue_type" | "player_id">;
        Update: Partial<QueueMemberRow>;
        Relationships: [];
      };
      crl6mansqueuebot_queue_messages: {
        Row: QueueMessageRow;
        Insert: QueueMessageRow;
        Update: Partial<QueueMessageRow>;
        Relationships: [];
      };
      crl6mansqueuebot_series_lobby: {
        Row: SeriesLobbyRow;
        Insert: Partial<SeriesLobbyRow> & Pick<SeriesLobbyRow, "series_id" | "player_id">;
        Update: Partial<SeriesLobbyRow>;
        Relationships: [];
      };
      crl6mansqueuebot_series_votes: {
        Row: SeriesVoteRow;
        Insert: SeriesVoteRow;
        Update: Partial<SeriesVoteRow>;
        Relationships: [];
      };
      crl6mansqueuebot_series_length_votes: {
        Row: SeriesLengthVoteRow;
        Insert: SeriesLengthVoteRow;
        Update: Partial<SeriesLengthVoteRow>;
        Relationships: [];
      };
      crl6mansqueuebot_cancel_votes: {
        Row: CancelVoteRow;
        Insert: Partial<CancelVoteRow> & Pick<CancelVoteRow, "series_id" | "player_id">;
        Update: Partial<CancelVoteRow>;
        Relationships: [];
      };
      crl6mansqueuebot_correct_votes: {
        Row: CorrectVoteRow;
        Insert: Partial<CorrectVoteRow> & Pick<CorrectVoteRow, "series_id" | "player_id">;
        Update: Partial<CorrectVoteRow>;
        Relationships: [];
      };
      crl6mansqueuebot_sub_requests: {
        Row: SubRequestRow;
        Insert: Partial<SubRequestRow> & Pick<SubRequestRow, "series_id" | "leaving_player_id" | "nominee_discord_id" | "team">;
        Update: Partial<SubRequestRow>;
        Relationships: [];
      };
      crl6mansqueuebot_abandon_votes: {
        Row: AbandonVoteRow;
        Insert: Partial<AbandonVoteRow> & Pick<AbandonVoteRow, "series_id" | "voter_player_id" | "target_player_id">;
        Update: Partial<AbandonVoteRow>;
        Relationships: [];
      };
      crl6mansqueuebot_band_roles: {
        Row: BandRoleRow;
        Insert: Partial<BandRoleRow> & Pick<BandRoleRow, "band" | "role_id">;
        Update: Partial<BandRoleRow>;
        Relationships: [];
      };
      crl6mansqueuebot_admin_roles: {
        Row: AdminRoleRow;
        Insert: Partial<AdminRoleRow> & Pick<AdminRoleRow, "role_id" | "added_by">;
        Update: Partial<AdminRoleRow>;
        Relationships: [];
      };
      crl6mansqueuebot_audit_log: {
        Row: AuditLogRow;
        Insert: Partial<AuditLogRow> & Pick<AuditLogRow, "actor_discord_id" | "action">;
        Update: Partial<AuditLogRow>;
        Relationships: [];
      };
      crl6mansqueuebot_time_of_day_stats: {
        Row: TimeOfDayStatsRow;
        Insert: TimeOfDayStatsRow;
        Update: Partial<TimeOfDayStatsRow>;
        Relationships: [];
      };
      crl6mansqueuebot_day_of_week_stats: {
        Row: DayOfWeekStatsRow;
        Insert: DayOfWeekStatsRow;
        Update: Partial<DayOfWeekStatsRow>;
        Relationships: [];
      };
      crl6mansqueuebot_mafia_games: {
        Row: MafiaGameRow;
        Insert: Partial<MafiaGameRow> & Pick<MafiaGameRow, "channel_id" | "guild_id" | "host_discord_id">;
        Update: Partial<MafiaGameRow>;
        Relationships: [];
      };
      crl6mansqueuebot_mafia_players: {
        Row: MafiaPlayerRow;
        Insert: MafiaPlayerRow;
        Update: Partial<MafiaPlayerRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      crl6mansqueuebot_join_queue: {
        Args: { p_queue_type: QueueType; p_player_id: string; p_max_size?: number };
        Returns: { status: "already_queued" | "full" | "joined"; queue_size: number }[];
      };
      crl6mansqueuebot_leave_queue: {
        Args: { p_queue_type: QueueType; p_player_id: string };
        Returns: { status: "not_queued" | "left"; queue_size: number }[];
      };
      crl6mansqueuebot_increment_match_time_stats: {
        Args: { p_segment_index: number; p_day_of_week: number; p_is_supercharged: boolean };
        Returns: undefined;
      };
      crl6mansqueuebot_mafia_join: {
        Args: {
          p_game_id: string;
          p_discord_id: string;
          p_display_name: string;
          p_interaction_token: string;
          p_max_size?: number;
        };
        Returns: { status: "not_open" | "already_joined" | "full" | "joined"; player_count: number }[];
      };
      crl6mansqueuebot_mafia_leave: {
        Args: { p_game_id: string; p_discord_id: string };
        Returns: { status: "not_open" | "not_joined" | "left"; player_count: number }[];
      };
      crl6mansqueuebot_assign_match_number: {
        Args: { p_series_id: string };
        Returns: number;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
