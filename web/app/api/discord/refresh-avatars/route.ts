import { NextResponse } from "next/server";
import { refreshPlayerAvatars } from "@/lib/discord/avatars";

export async function POST(request: Request) {
  const secret = process.env.CRON_SWEEP_SECRET;
  if (!secret) {
    throw new Error("Missing CRON_SWEEP_SECRET");
  }
  if (request.headers.get("x-sweep-secret") !== secret) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const summary = await refreshPlayerAvatars();
  return NextResponse.json({ ok: true, ...summary });
}
