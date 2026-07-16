import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "dev_panel_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours

function getSecret(): string {
  const secret = process.env.DEV_PANEL_PASSWORD;
  if (!secret) throw new Error("Missing DEV_PANEL_PASSWORD");
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function checkPassword(candidate: string): boolean {
  return constantTimeEqual(candidate, getSecret());
}

export function createSessionToken(): string {
  const payload = String(Date.now() + SESSION_TTL_SECONDS * 1000);
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  if (Number(payload) < Date.now()) return false;
  return constantTimeEqual(signature, sign(payload));
}
