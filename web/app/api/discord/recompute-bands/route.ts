import { NextResponse } from "next/server";
import { recomputeBands } from "@/lib/discord/bands";

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

  const summary = await recomputeBands();
  return NextResponse.json({ ok: true, ...summary });
}
