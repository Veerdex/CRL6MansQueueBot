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

export function interactionDisplayName(interaction: DiscordInteraction): string {
  const user = interaction.member?.user ?? interaction.user;
  return user?.global_name ?? user?.username ?? "Unknown";
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
