import "server-only";
import { verifyKey } from "discord-interactions";

export type VerifiedRequest =
  | { valid: true; body: string }
  | { valid: false; body: null };

// Discord signs the raw request body — must verify before JSON.parse, not after,
// or verification fails intermittently (whitespace/key-order changes break the signature).
export async function verifyDiscordRequest(request: Request): Promise<VerifiedRequest> {
  const publicKey = process.env.DISCORD_PUBLIC_KEY;
  if (!publicKey) {
    throw new Error("Missing DISCORD_PUBLIC_KEY");
  }

  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  const body = await request.text();

  if (!signature || !timestamp) {
    return { valid: false, body: null };
  }

  const valid = await verifyKey(body, signature, timestamp, publicKey);
  return valid ? { valid: true, body } : { valid: false, body: null };
}
