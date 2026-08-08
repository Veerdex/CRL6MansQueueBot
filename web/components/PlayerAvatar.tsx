// Shown to the left of a player's name everywhere a name appears on the site (Main leaderboard,
// Top Players, Season/All-Time stats). Sized in `em` (1.1x the surrounding font-size) rather than
// a fixed pixel value, per direct request, so it stays proportional to whatever text size it sits
// next to instead of needing a different size prop per call site. `avatarUrl` comes straight from
// players.avatar_url (refreshed daily — see lib/discord/avatars.ts); a plain `<img>`, not
// next/image, since the URL is Discord's CDN and this project avoids adding a remote-image
// allowlist for a single use case.
export default function PlayerAvatar({ avatarUrl, alt }: { avatarUrl: string | null; alt: string }) {
  const sizeStyle = { width: "1.1em", height: "1.1em" };

  if (!avatarUrl) {
    return (
      <span
        className="mr-1.5 inline-block shrink-0 rounded-full bg-surface-2 align-middle"
        style={sizeStyle}
        aria-hidden="true"
      />
    );
  }

  return (
    <img
      src={avatarUrl}
      alt={alt}
      className="mr-1.5 inline-block shrink-0 rounded-full align-middle object-cover"
      style={sizeStyle}
    />
  );
}
