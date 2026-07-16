import { NextResponse } from "next/server";
import { resetTestData } from "@/lib/test-data/generate";

export async function POST() {
  try {
    await resetTestData();
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("dev reset failed", error);
    return NextResponse.json({ ok: false, error: "Reset failed" }, { status: 500 });
  }
}
