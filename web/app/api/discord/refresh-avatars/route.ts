import { NextResponse } from "next/server";
import { refreshPlayerAvatars } from "@/lib/discord/avatars";
import { syncNicknameMedals, type NicknameMedalSummary } from "@/lib/discord/nicknameSync";

export async function POST(request: Request) {
  const secret = process.env.CRON_SWEEP_SECRET;
  if (!secret) {
    throw new Error("Missing CRON_SWEEP_SECRET");
  }
  if (request.headers.get("x-sweep-secret") !== secret) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const summary = await refreshPlayerAvatars();
  // Piggybacks on the same daily run: this is the pass that takes season medals back off anyone
  // who added them to their own nickname (see nicknameSync.ts). Best-effort — a Discord failure
  // here must not make the avatar refresh look like it failed.
  let medals: NicknameMedalSummary | { error: string };
  try {
    medals = await syncNicknameMedals();
  } catch (error) {
    console.error("Nickname medal sync failed", error);
    medals = { error: error instanceof Error ? error.message : String(error) };
  }
  return NextResponse.json({ ok: true, ...summary, medals });
}
