import { NextResponse } from "next/server";
import { recomputeBands } from "@/lib/discord/bands";

// Full-roster Discord role reconcile (syncAllRoles below) makes this the long pole — a normal
// day issues one guild-member list read and no writes, but the first run after a backlog can
// have real work to do. Same budget the sweep route takes.
export const maxDuration = 300;

// Called once daily by Supabase pg_cron (see CLAUDE.md, "Discord bot runtime architecture")
// since there's no interaction to hang a background recompute off of. Reuses the sweep
// route's shared secret rather than provisioning a second one — both are pg_net-triggered
// background jobs with the same trust boundary (Supabase calling this app, nothing else).
export async function POST(request: Request) {
  const secret = process.env.CRON_SWEEP_SECRET;
  if (!secret) {
    throw new Error("Missing CRON_SWEEP_SECRET");
  }
  if (request.headers.get("x-sweep-secret") !== secret) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // syncAllRoles: the daily job is one of only two callers that reconciles every player’s
  // Discord role against live state rather than just the ones whose band changed. See
  // syncPlayerRoles in bands.ts — report.ts deliberately stays off this path.
  const summary = await recomputeBands({ syncAllRoles: true });
  return NextResponse.json({ ok: true, ...summary });
}
