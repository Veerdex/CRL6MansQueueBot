// Fits the four constants in web/lib/mmr/teamStrength.ts against real reported series.
//
// Usage (from web/):
//   npm run fit-team-strength                 # fit + report, writes nothing
//   npm run fit-team-strength -- --folds 10   # more random CV folds (default 5)
//   npm run fit-team-strength -- --json out.json
//
// This script NEVER edits teamStrength.ts and never writes to the database. It prints candidate
// constants; applying them is a deliberate, separate human step.
//
// ---------------------------------------------------------------------------
// WHY THE PARAMETERS ARE SPLIT INTO "SHAPE" AND "CONFIDENCE"
// ---------------------------------------------------------------------------
// calculateTeamStrength is homogeneous of degree 1 in the transformed ratings: the power mean and
// the weakest-player blend are both degree-1, so scaling STRENGTH_MMR_SCALE and STRENGTH_MMR_SHIFT
// jointly by some lambda scales every team's strength by lambda, and hence every strength
// *difference* by lambda. Two consequences, and they pull in opposite directions:
//
//   1. Balanced mode (bestBalancedSplit) picks the split minimising |strengthA - strengthB|. An
//      argmin is invariant under a positive rescale, so lambda CANNOT change which teams Balanced
//      forms. Only the shape parameters can.
//   2. The Elo/odds path divides that difference by s_scale, so lambda is *exactly* the s_scale
//      knob in disguise (lambda == 400 / effective s_scale). It is also the cheapest possible
//      log-loss win whenever the model is mis-calibrated.
//
// Fitting all four jointly and quoting one headline number would therefore report a confidence
// rescale as if it were a team-formation improvement. So: STRENGTH_MMR_SCALE is pinned at its
// current value, the three shape parameters are fitted, and lambda is reported separately as an
// implied s_scale recommendation that can be accepted or declined independently.
//
// ---------------------------------------------------------------------------
// WHY LOG-LOSS AND NOT PICK ACCURACY
// ---------------------------------------------------------------------------
// Pick accuracy over ~220 binary outcomes is a step function: flat almost everywhere, jumping only
// when a parameter nudge flips a near-50% match, so it gives an optimizer nothing to descend.
// Log-loss is a strictly proper scoring rule, is smooth in the parameters, and rewards calibration
// as well as ordering. Accuracy and Brier are reported as secondary metrics.
//
// ---------------------------------------------------------------------------
// TWO CAVEATS THAT LIMIT WHAT ANY RESULT HERE MEANS
// ---------------------------------------------------------------------------
//   * Circularity. The mmr_before values being fitted against were themselves produced by the Elo
//     engine using this exact strength function. The fit is not against an independent
//     ground-truth skill measure.
//   * Counterfactual gap. Balanced mode chose its historical splits using the current constants,
//     so this measures how well the function *predicts* historical matchups, not how good the
//     teams it would have *formed* under new constants would have been. Those are different
//     questions, and only the first is answerable from this data.
// ---------------------------------------------------------------------------

import { calculateTeamStrength } from "../lib/mmr/teamStrength";

// Frozen copies of the live constants (web/lib/mmr/teamStrength.ts). Deliberately literal rather
// than imported, so this script keeps reporting a meaningful "current" baseline after that file is
// edited.
const CURRENT = { exponent: 0.785699, weakest: 0.036555, scale: 3.5, shift: 1550 };

// s_scale is absent from the live config table and falls through to KNOWN_CONFIG_DEFAULTS.
const S_SCALE = 400;

const TABLE_PREFIX = "crl6mansqueuebot_";

type Params = { exponent: number; weakest: number; shift: number; lambda: number };

type Match = {
  seriesId: string;
  matchNumber: number | null;
  seasonId: string | null;
  mode: string | null;
  createdAt: string;
  ratingsA: number[];
  ratingsB: number[];
  aWon: boolean;
};

// --- the model ------------------------------------------------------------

// calculateTeamStrength with the constants lifted out as parameters. scale stays pinned; see the
// shape/confidence note above.
function strength(ratings: number[], p: Params): number {
  const [strongest, second, weakest] = ratings
    .map((mmr) => Math.max(0, mmr * CURRENT.scale + p.shift))
    .sort((a, b) => b - a);
  const topTwoCore = ((strongest ** p.exponent + second ** p.exponent) / 2) ** (1 / p.exponent);
  return (1 - p.weakest) * topTwoCore + p.weakest * weakest;
}

function expectedA(m: Match, p: Params): number {
  const diff = strength(m.ratingsB, p) - strength(m.ratingsA, p);
  return 1 / (1 + 10 ** ((diff * p.lambda) / S_SCALE));
}

// --- objective ------------------------------------------------------------

const BOUNDS: Record<keyof Params, [number, number]> = {
  // A fractional exponent on a negative base is NaN, and Math.max(0, ...) would clip a team to a
  // degenerate 0. Both bounds keep every observed rating strictly positive after the transform.
  shift: [200, 8000],
  exponent: [0.2, 4],
  weakest: [0, 0.6],
  lambda: [0.15, 4],
};

function clamp(p: Params): Params {
  const out = { ...p };
  for (const k of Object.keys(BOUNDS) as (keyof Params)[]) {
    const [lo, hi] = BOUNDS[k];
    out[k] = Math.min(hi, Math.max(lo, out[k]));
  }
  return out;
}

function logLoss(matches: Match[], p: Params): number {
  if (!matches.length) return 0;
  let total = 0;
  for (const m of matches) {
    const e = expectedA(m, p);
    if (!Number.isFinite(e)) return Number.POSITIVE_INFINITY;
    // Exact 0.5 predictions are perfectly well defined for log-loss (they are only excluded from
    // accuracy, where a coin flip has no defensible tie-break).
    const clamped = Math.min(1 - 1e-12, Math.max(1e-12, e));
    total += -Math.log(m.aWon ? clamped : 1 - clamped);
  }
  return total / matches.length;
}

function metrics(matches: Match[], p: Params) {
  let correct = 0;
  let gradeable = 0;
  let brier = 0;
  for (const m of matches) {
    const e = expectedA(m, p);
    brier += (e - (m.aWon ? 1 : 0)) ** 2;
    if (Math.abs(e - 0.5) < 1e-9) continue;
    gradeable++;
    if (e > 0.5 === m.aWon) correct++;
  }
  return {
    logLoss: logLoss(matches, p),
    accuracy: gradeable ? correct / gradeable : 0,
    correct,
    gradeable,
    brier: matches.length ? brier / matches.length : 0,
  };
}

// --- Nelder-Mead over a chosen subset of the parameters -------------------

function nelderMead(matches: Match[], start: Params, free: (keyof Params)[], iterations = 3000): Params {
  const toVec = (p: Params) => free.map((k) => p[k]);
  const toParams = (v: number[]): Params => {
    const p = { ...start };
    free.forEach((k, i) => (p[k] = v[i]));
    return clamp(p);
  };
  const f = (v: number[]) => logLoss(matches, toParams(v));

  const n = free.length;
  const simplex: number[][] = [toVec(start)];
  for (let i = 0; i < n; i++) {
    const v = toVec(start).slice();
    const [lo, hi] = BOUNDS[free[i]];
    const step = Math.max(Math.abs(v[i]) * 0.15, (hi - lo) * 0.03);
    v[i] = Math.min(hi, Math.max(lo, v[i] + step));
    simplex.push(v);
  }
  let values = simplex.map(f);

  for (let iter = 0; iter < iterations; iter++) {
    const idx = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
    const best = idx[0];
    const worst = idx[n];
    const secondWorst = idx[n - 1];
    if (Math.abs(values[worst] - values[best]) < 1e-12) break;

    const centroid = new Array(n).fill(0);
    for (const i of idx.slice(0, n)) for (let d = 0; d < n; d++) centroid[d] += simplex[i][d] / n;

    const reflect = centroid.map((c, d) => c + (c - simplex[worst][d]));
    const fr = f(reflect);
    if (fr < values[best]) {
      const expand = centroid.map((c, d) => c + 2 * (c - simplex[worst][d]));
      const fe = f(expand);
      if (fe < fr) {
        simplex[worst] = expand;
        values[worst] = fe;
      } else {
        simplex[worst] = reflect;
        values[worst] = fr;
      }
    } else if (fr < values[secondWorst]) {
      simplex[worst] = reflect;
      values[worst] = fr;
    } else {
      const contract = centroid.map((c, d) => c + 0.5 * (simplex[worst][d] - c));
      const fc = f(contract);
      if (fc < values[worst]) {
        simplex[worst] = contract;
        values[worst] = fc;
      } else {
        for (const i of idx.slice(1)) {
          simplex[i] = simplex[i].map((x, d) => simplex[best][d] + 0.5 * (x - simplex[best][d]));
        }
        values = simplex.map(f);
      }
    }
  }
  const bestIdx = values.indexOf(Math.min(...values));
  return toParams(simplex[bestIdx]);
}

// Deterministic PRNG so repeated runs over the same data give the same answer.
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function multiStart(matches: Match[], free: (keyof Params)[], base: Params, restarts = 20): Params {
  const rng = makeRng(20260917);
  let best = nelderMead(matches, base, free);
  let bestLoss = logLoss(matches, best);
  for (let r = 0; r < restarts; r++) {
    const start = { ...base };
    for (const k of free) {
      const [lo, hi] = BOUNDS[k];
      start[k] = lo + rng() * (hi - lo);
    }
    const cand = nelderMead(matches, clamp(start), free);
    const loss = logLoss(matches, cand);
    if (loss < bestLoss) {
      best = cand;
      bestLoss = loss;
    }
  }
  return best;
}

// --- data -----------------------------------------------------------------

async function loadMatches(): Promise<Match[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — run via `npm run fit-team-strength`, which passes --env-file=.env.local",
    );
  }

  const get = async (path: string) => {
    const res = await fetch(`${url}/rest/v1/${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return res.json();
  };

  const series = await get(
    `${TABLE_PREFIX}series?select=id,match_number,winner_team,vote_result,season_id,created_at&status=eq.reported&is_test_data=eq.false&order=created_at.asc&limit=2000`,
  );
  const settled = series.filter((s: { winner_team: string | null }) => s.winner_team);

  const players: { series_id: string; team: string; mmr_before: number | null }[] = [];
  const ids = settled.map((s: { id: string }) => s.id);
  for (let i = 0; i < ids.length; i += 40) {
    players.push(
      ...(await get(
        `${TABLE_PREFIX}series_players?select=series_id,team,mmr_before&series_id=in.(${ids.slice(i, i + 40).join(",")})&limit=5000`,
      )),
    );
  }

  const bySeries = new Map<string, typeof players>();
  for (const row of players) {
    if (!bySeries.has(row.series_id)) bySeries.set(row.series_id, []);
    bySeries.get(row.series_id)!.push(row);
  }

  const matches: Match[] = [];
  for (const s of settled) {
    const rows = bySeries.get(s.id) ?? [];
    // A substituted series can carry more than six rows; anything that is not a clean 3v3 with a
    // recorded pre-match rating is unusable as a prediction target.
    if (rows.length !== 6 || rows.some((r) => r.mmr_before === null)) continue;
    const ratingsA = rows.filter((r) => r.team === "A").map((r) => r.mmr_before as number);
    const ratingsB = rows.filter((r) => r.team === "B").map((r) => r.mmr_before as number);
    if (ratingsA.length !== 3 || ratingsB.length !== 3) continue;
    matches.push({
      seriesId: s.id,
      matchNumber: s.match_number,
      seasonId: s.season_id,
      mode: s.vote_result,
      createdAt: s.created_at,
      ratingsA,
      ratingsB,
      aWon: s.winner_team === "A",
    });
  }
  return matches;
}

// --- how often would Balanced form a different team? ----------------------

// The metric that actually matters for team formation: a refit only changes Balanced's output if
// it changes bestBalancedSplit's argmin. Mirrors that function (web/lib/discord/teamFormation.ts)
// — brute-force the 10 unique 3v3 splits, smallest strength gap wins. Fixing player 0 on the first
// team enumerates exactly those 10.
function bestSplitKey(roster: number[], p: Params): string {
  let bestDiff = Infinity;
  let bestSplit = "";
  for (let j = 1; j < 6; j++) {
    for (let k = j + 1; k < 6; k++) {
      const teamIdx = [0, j, k];
      const other = [1, 2, 3, 4, 5].filter((x) => x !== j && x !== k);
      const diff = Math.abs(
        strength(teamIdx.map((x) => roster[x]), p) - strength(other.map((x) => roster[x]), p),
      );
      if (diff < bestDiff) {
        bestDiff = diff;
        bestSplit = teamIdx.join(",");
      }
    }
  }
  return bestSplit;
}

function splitDisagreement(matches: Match[], a: Params, b: Params) {
  let differ = 0;
  for (const m of matches) {
    const roster = [...m.ratingsA, ...m.ratingsB];
    if (bestSplitKey(roster, a) !== bestSplitKey(roster, b)) differ++;
  }
  return { differ, total: matches.length };
}

// --- reporting ------------------------------------------------------------

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

// Is a refit distinguishable from the current constants at all, or is it just spending free
// parameters on noise? Log-loss times n is a negative log-likelihood, so twice the in-sample
// improvement times n is the standard likelihood-ratio statistic, chi-squared on (number of freed
// parameters) degrees of freedom. A small improvement over 221 coin flips is expected by chance,
// and this says how small "small" is.
function chiSquaredP(stat: number, df: number): number {
  // Upper tail of chi-squared via the regularised incomplete gamma Q(df/2, stat/2), series form.
  if (stat <= 0) return 1;
  const a = df / 2;
  const x = stat / 2;
  const lg = (z: number): number => {
    // Lanczos approximation, plenty accurate for the small integer df used here.
    const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
      12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lg(1 - z);
    z -= 1;
    let sum = 0.99999999999980993;
    g.forEach((c, i) => (sum += c / (z + i + 1)));
    const t = z + g.length - 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
  };
  let sum = 1 / a;
  let term = sum;
  for (let i = 1; i < 500; i++) {
    term *= x / (a + i);
    sum += term;
    if (term < sum * 1e-14) break;
  }
  const lowerP = sum * Math.exp(-x + a * Math.log(x) - lg(a));
  return Math.max(0, Math.min(1, 1 - lowerP));
}

function significance(label: string, matches: Match[], base: Params, fitted: Params, df: number) {
  const stat = 2 * matches.length * (logLoss(matches, base) - logLoss(matches, fitted));
  const p = chiSquaredP(stat, df);
  console.log(
    `  ${label.padEnd(30)} LR chi2 = ${stat.toFixed(2)} on ${df} df   p = ${p.toFixed(3)}` +
      (p < 0.05 ? "   <- distinguishable from the current constants" : "   <- NOT distinguishable from the current constants"),
  );
}

function report(label: string, matches: Match[], p: Params) {
  const m = metrics(matches, p);
  console.log(
    `  ${label.padEnd(30)} logloss ${m.logLoss.toFixed(4)}   acc ${m.correct}/${m.gradeable} = ${pct(m.accuracy)}   brier ${m.brier.toFixed(4)}`,
  );
  return m;
}

function showParams(label: string, p: Params) {
  console.log(`\n${label}`);
  console.log(`  TOP_TWO_EXPONENT   = ${p.exponent.toFixed(6)}   (now ${CURRENT.exponent})`);
  console.log(`  WEAKEST_WEIGHT     = ${p.weakest.toFixed(6)}   (now ${CURRENT.weakest})`);
  console.log(`  STRENGTH_MMR_SCALE = ${CURRENT.scale} (pinned)`);
  console.log(`  STRENGTH_MMR_SHIFT = ${p.shift.toFixed(3)}      (now ${CURRENT.shift})`);
  console.log(
    `  lambda             = ${p.lambda.toFixed(4)}  -> implied s_scale ${(S_SCALE / p.lambda).toFixed(1)} (currently ${S_SCALE})`,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const folds = Number(argv[argv.indexOf("--folds") + 1]) || 5;

  const matches = await loadMatches();
  console.log(`Loaded ${matches.length} reported, non-test, clean-3v3 series.`);

  const current: Params = {
    exponent: CURRENT.exponent,
    weakest: CURRENT.weakest,
    shift: CURRENT.shift,
    lambda: 1,
  };

  // Self-check: the parameterised strength() must reproduce the live function exactly at the frozen
  // constants, or every number below is measuring the wrong model.
  for (const m of matches.slice(0, 25)) {
    for (const r of [m.ratingsA, m.ratingsB]) {
      if (Math.abs(strength(r, current) - calculateTeamStrength(r)) > 1e-9) {
        throw new Error(
          "strength() does not reproduce calculateTeamStrength at the frozen constants — refusing to report a fit",
        );
      }
    }
  }
  console.log("Self-check passed: parameterised strength() matches calculateTeamStrength() at current constants.\n");

  const SHAPE: (keyof Params)[] = ["shift", "exponent", "weakest"];
  const ALL: (keyof Params)[] = [...SHAPE, "lambda"];

  console.log("In-sample (all series):");
  report("current constants", matches, current);
  const shapeOnly = multiStart(matches, SHAPE, current);
  report("shape refit (lambda pinned 1)", matches, shapeOnly);
  const joint = multiStart(matches, ALL, current);
  report("shape + lambda", matches, joint);
  const lambdaOnly = multiStart(matches, ["lambda"], current);
  report("lambda only (confidence)", matches, lambdaOnly);

  console.log("\nIs any of that a real improvement, or noise? (likelihood-ratio vs current constants)");
  significance("shape refit", matches, current, shapeOnly, 3);
  significance("shape + lambda", matches, current, joint, 4);
  significance("lambda only", matches, current, lambdaOnly, 1);

  showParams("SHAPE REFIT (this is the part that changes which teams Balanced forms):", shapeOnly);
  showParams("JOINT REFIT:", joint);
  console.log(
    `\nCONFIDENCE ONLY: lambda ${lambdaOnly.lambda.toFixed(4)} -> s_scale ${(S_SCALE / lambdaOnly.lambda).toFixed(1)}`,
  );
  console.log(
    "  (cannot change Balanced's teams at all — the argmin is scale-invariant — it only moves displayed odds and Elo deltas)",
  );

  // --- honest out-of-sample -------------------------------------------------
  const seasons = [...new Set(matches.map((m) => m.seasonId))];
  console.log(`\nTemporal holdout (train on earlier seasons, test on the newest) — ${seasons.length} season(s) seen:`);
  if (seasons.length >= 2) {
    const newest = matches[matches.length - 1].seasonId;
    const train = matches.filter((m) => m.seasonId !== newest);
    const test = matches.filter((m) => m.seasonId === newest);
    console.log(`  train n=${train.length}  test n=${test.length}`);
    const shapeT = multiStart(train, SHAPE, current);
    const jointT = multiStart(train, ALL, current);
    const lambdaT = multiStart(train, ["lambda"], current);
    report("current -> test", test, current);
    report("shape refit -> test", test, shapeT);
    report("joint refit -> test", test, jointT);
    report("lambda only -> test", test, lambdaT);
  } else {
    console.log("  skipped: only one season of data");
  }

  console.log(`\nRandom ${folds}-fold cross-validation (secondary; it leaks across the season boundary):`);
  const rng = makeRng(424242);
  const shuffled = matches
    .map((m) => ({ m, r: rng() }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.m);
  let cvCurrent = 0;
  let cvShape = 0;
  let cvJoint = 0;
  let cvLambda = 0;
  for (let f = 0; f < folds; f++) {
    const test = shuffled.filter((_, i) => i % folds === f);
    const train = shuffled.filter((_, i) => i % folds !== f);
    cvCurrent += logLoss(test, current) * test.length;
    cvShape += logLoss(test, multiStart(train, SHAPE, current, 8)) * test.length;
    cvJoint += logLoss(test, multiStart(train, ALL, current, 8)) * test.length;
    cvLambda += logLoss(test, multiStart(train, ["lambda"], current, 8)) * test.length;
  }
  console.log(`  current      out-of-sample logloss ${(cvCurrent / matches.length).toFixed(4)}`);
  console.log(`  shape refit  out-of-sample logloss ${(cvShape / matches.length).toFixed(4)}`);
  console.log(`  joint refit  out-of-sample logloss ${(cvJoint / matches.length).toFixed(4)}`);
  console.log(`  lambda only  out-of-sample logloss ${(cvLambda / matches.length).toFixed(4)}`);
  console.log("  (a refit that does not beat \"current\" here is overfitting, not an improvement)");

  // --- does this actually change team formation? ---------------------------
  for (const [label, p] of [
    ["shape refit", shapeOnly],
    ["joint refit", joint],
  ] as [string, Params][]) {
    const d = splitDisagreement(matches, current, p);
    console.log(
      `\n${label}: Balanced would have formed DIFFERENT teams in ${d.differ}/${d.total} historical rosters (${pct(d.differ / d.total)}).`,
    );
  }

  const jsonIdx = argv.indexOf("--json");
  if (jsonIdx !== -1 && argv[jsonIdx + 1]) {
    const fs = await import("node:fs");
    fs.writeFileSync(argv[jsonIdx + 1], JSON.stringify({ current, shapeOnly, joint, lambdaOnly }, null, 2));
    console.log(`\nWrote ${argv[jsonIdx + 1]}`);
  }

  console.log("\nNothing was written to teamStrength.ts or the database.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
