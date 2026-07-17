export type QueueType = "rank" | "universal";
export type SeriesStatus = "forming" | "active" | "reported" | "cancelled" | "void";
export type Team = "A" | "B";
export type Band = "Iron" | "Garnet" | "Emerald" | "Sapphire";
export type VoteChoice = "balanced" | "captains";

// Row shapes must be `type` aliases, not `interface` — interfaces don't get an
// implicit index signature, so they fail postgrest-js's `Record<string, unknown>`
// constraint on GenericTable and silently resolve query results to `never`.
export type PlayerRow = {
  id: string;
  discord_id: string;
  display_name: string;
  mmr: number;
  band: Band | null;
  is_placed: boolean;
  total_games_played: number;
  rank_games_played: number;
  band_games_played: number;
  is_prism: boolean;
  is_test_data: boolean;
  vote_default: VoteChoice | null;
  created_at: string;
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
};

export type SeriesPlayerRow = {
  series_id: string;
  player_id: string;
  team: Team;
  mmr_delta: number;
};

export type SeasonHistoryRow = {
  season_id: string;
  player_id: string;
  mmr_at_close: number;
  season_games_played: number;
  season_rank: number;
  made_top10: boolean;
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
  message_id: string;
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

export type CancelVoteRow = {
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
      crl6mansqueuebot_cancel_votes: {
        Row: CancelVoteRow;
        Insert: Partial<CancelVoteRow> & Pick<CancelVoteRow, "series_id" | "player_id">;
        Update: Partial<CancelVoteRow>;
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
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
