// Discord permission bits actually used by this bot. Kept as BigInt since permission
// bitfields exceed Number's safe-integer range; converted to string for API payloads.
// BigInt(1) instead of `1n` literals — tsc rejects BigInt literal syntax below ES2020,
// and bumping the whole project's tsconfig target isn't warranted just for this.
export const VIEW_CHANNEL = BigInt(1) << BigInt(10);
export const SEND_MESSAGES = BigInt(1) << BigInt(11);
export const CONNECT = BigInt(1) << BigInt(20);

export const ROLE_TYPE = 0;
export const MEMBER_TYPE = 1;

export type PermissionOverwrite = {
  id: string;
  type: 0 | 1;
  allow?: string;
  deny?: string;
};
