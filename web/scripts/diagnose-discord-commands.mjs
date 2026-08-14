// Read-only diagnostic for "a command is registered but doesn't show up in Discord".
//
// Deliberately performs NO writes — it never PUTs/POSTs anything, so it's safe to run at any
// time without touching the live command set. Reads the guild's command list *back out* of
// Discord (rather than trusting what a registration PUT echoed back) and dumps the command
// permission overrides, which can hide a command from the picker while it stays registered.
//
// Run with: node --env-file=.env.local scripts/diagnose-discord-commands.mjs

const token = process.env.DISCORD_BOT_TOKEN;
const appId = process.env.DISCORD_APPLICATION_ID;

if (!token || !appId) {
  console.error("Missing DISCORD_BOT_TOKEN or DISCORD_APPLICATION_ID in the environment.");
  process.exit(1);
}

const auth = { Authorization: `Bot ${token}` };
const api = "https://discord.com/api/v10";

// Which application does this token actually belong to? A DISCORD_APPLICATION_ID pointing at a
// different app than the token would register commands somewhere nobody is looking.
const meRes = await fetch(`${api}/users/@me`, { headers: auth });
const me = await meRes.json();
console.log(`Bot user: ${me.username} (id ${me.id})`);
console.log(`DISCORD_APPLICATION_ID: ${appId}`);
console.log(`Bot user id === application id? ${me.id === appId ? "yes" : "NO — these should match for a bot app"}`);

let guildId = process.env.DISCORD_GUILD_ID;
const guildsRes = await fetch(`${api}/users/@me/guilds`, { headers: auth });
const guilds = await guildsRes.json();
console.log(`Bot is in ${guilds.length} guild(s): ${guilds.map((g) => `${g.name} (${g.id})`).join(", ")}`);
if (!guildId) guildId = guilds[0]?.id;
console.log(`Inspecting guild: ${guildId}`);

// Fresh read-back of what Discord currently has stored, independent of any registration run.
const cmdRes = await fetch(`${api}/applications/${appId}/guilds/${guildId}/commands`, { headers: auth });
if (!cmdRes.ok) {
  console.error(`Failed to read guild commands: ${cmdRes.status} ${await cmdRes.text()}`);
  process.exit(1);
}
const cmds = await cmdRes.json();
console.log(`\nGuild has ${cmds.length} command(s) stored.`);

const admin = cmds.find((c) => c.name === "admin");
if (!admin) {
  console.log("No /admin command found in the guild command list.");
} else {
  console.log(`\n/admin id=${admin.id} version=${admin.version}`);
  console.log(`  default_member_permissions: ${admin.default_member_permissions}`);
  console.log(`  dm_permission: ${admin.dm_permission}  nsfw: ${admin.nsfw}`);
  console.log(`  subcommands (${admin.options?.length ?? 0}):`);
  for (const o of admin.options ?? []) {
    console.log(`    - ${o.name} (type ${o.type}, ${o.options?.length ?? 0} option(s))`);
  }
  const target = (admin.options ?? []).find((o) => o.name === "series-length-vote");
  console.log(`\nseries-length-vote present in live read-back? ${target ? "YES" : "NO"}`);
  if (target) console.log(JSON.stringify(target, null, 2));
}

// Permission overrides are the classic cause of "registered but invisible": an override can
// restrict a command to specific roles/channels, and Discord then hides it in the picker for
// anyone it doesn't apply to.
const permRes = await fetch(`${api}/applications/${appId}/guilds/${guildId}/commands/permissions`, { headers: auth });
console.log(`\nCommand permission overrides (HTTP ${permRes.status}):`);
const permBody = await permRes.text();
console.log(permBody.length > 4000 ? `${permBody.slice(0, 4000)}… (truncated)` : permBody);
