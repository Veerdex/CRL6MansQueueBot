import { NextResponse } from "next/server";
import { generateTestData } from "@/lib/test-data/generate";

export async function POST() {
  try {
    const result = await generateTestData();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("dev seed failed", error);
    return NextResponse.json({ ok: false, error: "Seed failed" }, { status: 500 });
  }
}
