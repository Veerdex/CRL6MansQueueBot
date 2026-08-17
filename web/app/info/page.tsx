import Link from "next/link";
import { getConfigNumber } from "@/lib/discord/config";
import { getPlacedPlayerBandMMRs } from "@/lib/leaderboard/queries";
import { REPORT_COOLDOWN_MINUTES_BY_LENGTH } from "@/lib/discord/teamFormation";
import type { Band } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Info — CRL West 6 Mans",
};

const BAND_ORDER: readonly Band[] = ["Iron", "Garnet", "Emerald", "Sapphire"];

const BAND_IMAGES: Record<Band, string> = {
  Iron: "/ranks/Iron.png",
  Garnet: "/ranks/Garnet.png",
  Emerald: "/ranks/Emerald.png",
  Sapphire: "/ranks/Sapphire.png",
};

const PRISM_IMAGE = "/info/prism.png";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-3 text-lg font-bold text-foreground">{title}</h2>
      <div className="space-y-2 text-sm leading-relaxed text-foreground/90">{children}</div>
    </section>
  );
}

export default async function InfoPage() {
  const [
    seriesTimeoutHours,
    bonusDayEnabled,
    bonusDayStart,
    bonusDayEnd,
    bonusDayBonusPct,
    garnetCutoff,
    emeraldCutoff,
    sapphireCutoff,
    placementGamesRequired,
    graceGames,
    mmrScale,
    mmrShift,
    prismTopN,
    top10MinGames,
    placedBandMMRs,
    seriesLengthVoteEnabled,
    reportCooldownEnabled,
  ] = await Promise.all([
    getConfigNumber("series_timeout_hours", 2),
    getConfigNumber("bonus_day_enabled", 1),
    getConfigNumber("bonus_day_start", 6),
    getConfigNumber("bonus_day_end", 6),
    getConfigNumber("bonus_day_bonus_pct", 50),
    getConfigNumber("band_cutoff_garnet_pctile", 40),
    getConfigNumber("band_cutoff_emerald_pctile", 70),
    getConfigNumber("band_cutoff_sapphire_pctile", 90),
    getConfigNumber("placement_games_required", 10),
    getConfigNumber("grace_games", 3),
    getConfigNumber("mmr_scale", 1),
    getConfigNumber("mmr_shift", 0),
    getConfigNumber("prism_top_n", 1),
    getConfigNumber("top10_min_games", 8),
    getPlacedPlayerBandMMRs(),
    getConfigNumber("series_length_vote_enabled", 0),
    getConfigNumber("report_cooldown_enabled", 1),
  ]);

  // Single-value simplification (this session) of the old current-members min–max range: each
  // band's card now shows the floor MMR (lowest among players currently holding that band) instead
  // of a full range. Deliberately still grouped by real, current band membership — not a
  // re-derivation of bands.ts's percentile-threshold math, which would manufacture fake-looking
  // single-point numbers for sparsely- or un-populated bands at this project's small player counts
  // (see CLAUDE.md, "Website implementation notes").
  const bandFloorMmr = new Map<Band, number>();
  for (const { band, mmr } of placedBandMMRs) {
    const displayMmr = Math.round(mmr * mmrScale + mmrShift);
    const existing = bandFloorMmr.get(band);
    if (existing === undefined || displayMmr < existing) {
      bandFloorMmr.set(band, displayMmr);
    }
  }
  // Revised a later session — supersedes an ">Sapphire's max MMR" floor, which could read as a
  // healthier cutoff than reality: a high-MMR Sapphire player who hasn't hit top10_min_games yet
  // isn't actually holding Prism, so deriving the floor from Sapphire's max ignored that gap.
  // Now computed straight from who currently, actually holds is_prism (see bands.ts's matching
  // /ranks fix) — the worst (lowest-MMR) current Prism player's real MMR.
  const prismMinMmr = placedBandMMRs
    .filter((p) => p.isPrism)
    .reduce<number | undefined>((min, p) => {
      const displayMmr = Math.round(p.mmr * mmrScale + mmrShift);
      return min === undefined || displayMmr < min ? displayMmr : min;
    }, undefined);

  const bandPercentileLabel: Record<Band, string> = {
    Iron: `bottom ${garnetCutoff}%`,
    Garnet: `${garnetCutoff}th–${emeraldCutoff}th percentile`,
    Emerald: `${emeraldCutoff}th–${sapphireCutoff}th percentile`,
    Sapphire: `top ${100 - sapphireCutoff}%`,
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10">
      <Link
        href="/"
        className="animate-in mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-muted transition-opacity hover:opacity-80"
      >
        ← Back to Leaderboard
      </Link>

      <h1 className="animate-in mb-6 text-2xl font-bold text-foreground">Info</h1>

      <div className="panel animate-in-delay-1 p-4 sm:p-6">
        <Section title="Queueing">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              <strong>Universal Queue</strong> is open to everyone and is <em>fully unranked</em> — results
              there never change your MMR.
            </li>
            <li>
              <strong>Rank Queue</strong> is also open to everyone, no placement requirement — this is the
              queue that moves your MMR and band.
            </li>
            <li>
              Join with <strong>/q</strong> (or <strong>/queue</strong>), leave with <strong>/l</strong> (or{" "}
              <strong>/leave</strong>).
            </li>
            <li>
              Once a queue fills to <strong>6 players</strong>, everyone in that match is locked out of
              queueing until the match is reported.
            </li>
            {seriesLengthVoteEnabled === 1 && (
              <li>
                Right after a pop, vote for the match length — <strong>Best of 3, 5, or 7</strong> — before the
                Balanced/Captains vote. A shorter series moves your MMR <em>less</em> (Best of 3 = 0.6x), a
                longer one moves it <em>more</em> (Best of 7 = 1.4x); Best of 5 is the normal rate.
              </li>
            )}
            <li>
              After a pop, vote for <strong>Balanced</strong> teams or a <strong>Captains</strong> draft. Set
              a default with <strong>/vote-default</strong> so you don&apos;t have to vote every time.
            </li>
            {reportCooldownEnabled === 1 && (
              <li>
                Once teams are set, there&apos;s a short cooldown before <strong>/report</strong> is
                accepted — long enough that the series could plausibly have actually finished:{" "}
                <strong>{REPORT_COOLDOWN_MINUTES_BY_LENGTH.bo3} minutes</strong> for Best of 3,{" "}
                <strong>{REPORT_COOLDOWN_MINUTES_BY_LENGTH.bo5}</strong> for Best of 5, and{" "}
                <strong>{REPORT_COOLDOWN_MINUTES_BY_LENGTH.bo7}</strong> for Best of 7.
              </li>
            )}
            <li>
              Didn&apos;t get reported? A match <em>auto-cancels</em> after {seriesTimeoutHours} hour
              {seriesTimeoutHours === 1 ? "" : "s"} with no MMR change. You can also vote it away early with{" "}
              <strong>/cancel</strong> (4 of 6 players) or call out an AFK teammate with{" "}
              <strong>/abandon</strong> (3 of the other 5).
            </li>
          </ul>
        </Section>

        <Section title="Win Streaks">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              Win <strong>3 Rank Queue games in a row</strong> and you get a 🔥 next to your name — in bot
              messages and on the <strong>Main Leaderboard</strong>.
            </li>
            <li>
              From that 3rd win onward, each extra win in the streak adds a small <em>bonus</em> on top of
              your normal MMR gain — the longer the streak, the bigger the bonus (it caps out on longer
              streaks).
            </li>
            <li>
              Reach a <strong>5+ game streak</strong> and the bot posts a public shoutout for it.
            </li>
            <li>
              A single loss <em>resets your streak to zero</em> — bonus included.
            </li>
            <li>
              Lose <strong>3 Rank Queue games in a row</strong> and you get a 🥶 next to your name instead —
              same bot messages and Main Leaderboard treatment as the fire streak, but purely visual with{" "}
              <strong>no effect on MMR</strong>.
            </li>
          </ul>
        </Section>

        <Section title="Bonuses">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              {bonusDayStart === bonusDayEnd ? (
                <>
                  <strong>Bonus Day</strong> is <strong>{DAY_NAMES[bonusDayStart] ?? "Saturday"}</strong>
                </>
              ) : (
                <>
                  <strong>Bonus Range</strong> runs from <strong>{DAY_NAMES[bonusDayStart] ?? "Saturday"}</strong>{" "}
                  through <strong>{DAY_NAMES[bonusDayEnd] ?? "Saturday"}</strong>
                </>
              )}{" "}
              — Rank Queue MMR gains and losses are boosted by <strong>+{bonusDayBonusPct}%</strong> the whole
              time{!bonusDayEnabled && <em> (currently disabled)</em>}.
            </li>
            <li>
              The window starts at <strong>midnight Pacific time</strong> on the first day and ends at{" "}
              <strong>midnight Pacific time</strong> the day after the final day.
            </li>
            <li>
              What matters is when your match <em>pops</em> (fills to 6/6) — if that happens inside the
              window, you keep the bonus even if you don&apos;t report until after it closes.
            </li>
            <li>
              <em>Universal Queue is never affected</em> — it doesn&apos;t touch MMR at all.
            </li>
            <li>The win-streak bonus above stacks with the Bonus Range.</li>
          </ul>
        </Section>

        <Section title="Bands">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              Four skill bands, low to high: <strong>Iron → Garnet → Emerald → Sapphire</strong>, split by
              MMR percentile: Iron ({bandPercentileLabel.Iron}), Garnet ({bandPercentileLabel.Garnet}),
              Emerald ({bandPercentileLabel.Emerald}), Sapphire ({bandPercentileLabel.Sapphire}).
            </li>
            <li>
              <strong>Prism</strong> is a live tier for Sapphire players who are also currently{" "}
              <strong>
                {prismTopN === 1 ? "the #1 Sapphire player" : `in the top ${prismTopN} Sapphire players`}
              </strong>{" "}
              by MMR (with at least {top10MinGames} Rank Queue games played this season) — you gain and
              lose it the instant your standing crosses that line, not just at season close.
            </li>
            <li>
              Your band is based on how your MMR compares to everyone else&apos;s, recalculated{" "}
              <em>daily</em> and also right after your own matches.
            </li>
            <li>
              You can queue Rank Queue immediately, but you&apos;ll need to play{" "}
              <strong>{placementGamesRequired} Rank Queue games</strong> before you&apos;re assigned a real
              band — until then you show as <strong>unranked</strong>.
            </li>
            <li>
              <strong>Promotions</strong> happen the moment you qualify. <strong>Demotions</strong> are
              softer — you get a <strong>{graceGames}-game grace period</strong> right after moving up, and
              after that you need to fall clearly below the cutoff, not just brush it, before dropping back
              down.
            </li>
          </ul>

          <ul className="mt-4 space-y-3">
            {BAND_ORDER.map((band) => {
              const floorMmr = bandFloorMmr.get(band);
              return (
                <li key={band} className="flex items-center gap-3 rounded-lg bg-surface-2/40 px-3 py-2.5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={BAND_IMAGES[band]} alt={band} className="h-10 w-10 shrink-0 object-contain" />
                  <div className="min-w-0">
                    <div className="font-semibold text-foreground">{band}</div>
                    <div className="text-xs text-muted">
                      {floorMmr === undefined ? "No players currently placed in this band" : `Currently ${floorMmr} MMR`}
                    </div>
                  </div>
                </li>
              );
            })}
            <li className="flex items-center gap-3 rounded-lg bg-surface-2/40 px-3 py-2.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={PRISM_IMAGE} alt="Prism" className="h-10 w-10 shrink-0 object-contain" />
              <div className="min-w-0">
                <div className="font-semibold text-foreground">Prism</div>
                <div className="text-xs text-muted">
                  {prismMinMmr === undefined ? "No players currently hold Prism" : `Currently ${prismMinMmr} MMR`} •{" "}
                  {prismTopN === 1 ? "Live #1 cut" : `Live top ${prismTopN} cut`}, min {top10MinGames} games
                  this season
                </div>
              </div>
            </li>
          </ul>
          <p className="text-xs text-muted">
            Values reflect current standings and shift as players climb, drop, and place — treat them as
            approximate, not fixed thresholds.
          </p>
        </Section>
      </div>
    </div>
  );
}
