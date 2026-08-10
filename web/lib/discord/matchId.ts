// Custom base-36 match ID encoding using: 0-9, a-z
// Game 0 = "0", Game 10 = "a", Game 35 = "z", Game 36 = "10"

const CHARSET = "0123456789abcdefghijklmnopqrstuvwxyz";
const BASE = CHARSET.length; // 36

export function encodeMatchId(matchNumber: number): string {
  if (matchNumber < 0) return "0";
  if (matchNumber < BASE) return CHARSET[matchNumber];

  let result = "";
  let num = matchNumber;
  while (num > 0) {
    result = CHARSET[num % BASE] + result;
    num = Math.floor(num / BASE);
  }
  return result;
}

export function decodeMatchId(encoded: string): number {
  let result = 0;
  for (const char of encoded) {
    const index = CHARSET.indexOf(char);
    if (index === -1) return 0;
    result = result * BASE + index;
  }
  return result;
}
