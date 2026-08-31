import { stripMedals } from "./nicknameMedals";

// Minimal shapes for the fields this bot actually reads off an interaction payload —
// not a full Discord API type package, just what's needed here.

export type DiscordUser = {
  id: string;
  username: string;
  global_name: string | null;
};

export type DiscordMember = {
  user: DiscordUser;
  roles: string[];
  // Per-server nickname — null when the member hasn't set one, in which case
  // interactionDisplayName below falls back to their account-wide global_name/username.
  nick: string | null;
};

// A command option is either a leaf param (`value` set) or a subcommand/subcommand-group node
// (`options` set, holding its nested params or the next-level subcommand) — /admin's
// subcommand-group ("config get"/"config set") is the only nested case in this bot; see
// adminTools.ts's resolveAdminSubcommandPath for how the two shapes are told apart.
export type CommandOption = { name: string; value?: string | number | boolean; options?: CommandOption[] };

// A MODAL_SUBMIT interaction's data.components — a tree of action rows wrapping input fields,
// each leaf carrying the user's typed value under its own custom_id. See modalFieldValue below.
export type ModalSubmitComponent = {
  type: number;
  custom_id?: string;
  value?: string;
  components?: ModalSubmitComponent[];
};

export type DiscordInteraction = {
  type: number;
  id: string;
  token: string;
  channel_id?: string;
  guild_id?: string;
  member?: DiscordMember;
  user?: DiscordUser;
  data?: {
    name?: string;
    custom_id?: string;
    component_type?: number;
    values?: string[];
    options?: CommandOption[];
    components?: ModalSubmitComponent[];
    resolved?: {
      attachments?: Record<string, { id: string; url: string; content_type?: string }>;
    };
  };
};

export function interactionUserId(interaction: DiscordInteraction): string | null {
  return interaction.member?.user.id ?? interaction.user?.id ?? null;
}

// Strips a leading clan/team tag like "[BSU] PlayerName" -> "PlayerName" — common on this
// server's nicknames. Only strips a single bracket group anchored at the very start (plus any
// whitespace right after it), so brackets appearing later in a name are left alone. Exported for
// avatars.ts's bulk nickname sync, which needs the exact same stripping applied to guild member
// list results as interactionDisplayName applies to live interactions.
export function stripClanTag(name: string): string {
  return name.replace(/^\[[^\]]*\]\s*/, "").trim();
}

// Prefers the member's per-server nickname over their account-wide global_name/username — a
// nickname is what this server actually knows a player by, and is also where clan tags like
// "[BSU]" get set, hence the stripClanTag pass on every candidate. Season medals are stripped
// for the same reason (see nicknameMedals.ts): they belong in the Discord nickname, not in the
// display_name this writes through getOrCreatePlayer on every command. Falls through to the next
// candidate if a stripped value comes back empty (e.g. a nickname that was only a tag).
export function interactionDisplayName(interaction: DiscordInteraction): string {
  const user = interaction.member?.user ?? interaction.user;
  const candidates = [interaction.member?.nick, user?.global_name, user?.username];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const stripped = stripMedals(stripClanTag(candidate));
    if (stripped) return stripped;
  }
  return "Unknown";
}

// Recursively finds a submitted modal field's value by custom_id — modal components nest one
// level (ACTION_ROW -> input) but this walks arbitrarily deep in case Discord ever nests further.
export function modalFieldValue(interaction: DiscordInteraction, customId: string): string | null {
  function search(components: ModalSubmitComponent[] | undefined): string | null {
    if (!components) return null;
    for (const c of components) {
      if (c.custom_id === customId && typeof c.value === "string") return c.value;
      const nested = search(c.components);
      if (nested !== null) return nested;
    }
    return null;
  }
  return search(interaction.data?.components);
}
