import { describe, expect, it } from "vitest";
import {
  MAX_NICKNAME_MEDALS,
  NICKNAME_MAX_LENGTH,
  desiredNickname,
  hasMedals,
  medalsForFinishes,
  nicknameLength,
  stripMedals,
} from "./nicknameMedals";

const GOLD = "\u{1F947}";
const SILVER = "\u{1F948}";
const BRONZE = "\u{1F949}";

const member = (nick: string | null, username = "player", globalName: string | null = null) => ({
  nick,
  user: { username, global_name: globalName },
});

describe("stripMedals", () => {
  it("removes a trailing medal run without leaving trailing space", () => {
    expect(stripMedals(`Grant ${GOLD} ${BRONZE} ${SILVER}`)).toBe("Grant");
  });

  it("removes medals from anywhere a tamperer puts them", () => {
    expect(stripMedals(`${GOLD}Grant`)).toBe("Grant");
    expect(stripMedals(`${GOLD} Grant ${SILVER} `)).toBe("Grant");
  });

  it("preserves a clan tag and the name's own internal spacing", () => {
    expect(stripMedals(`[CRL] Grant ${GOLD}`)).toBe("[CRL] Grant");
    expect(stripMedals("Cool  Guy")).toBe("Cool  Guy");
  });

  it("leaves a medal-free name completely untouched", () => {
    expect(stripMedals("Grant")).toBe("Grant");
    expect(hasMedals("Grant")).toBe(false);
    expect(hasMedals(`Grant ${GOLD}`)).toBe(true);
    expect(hasMedals(null)).toBe(false);
  });
});

describe("medalsForFinishes", () => {
  it("orders medals chronologically by season, oldest first", () => {
    const medals = medalsForFinishes([
      { seasonNumber: 3, rank: 2 },
      { seasonNumber: 1, rank: 1 },
      { seasonNumber: 2, rank: 3 },
    ]);
    expect(medals).toEqual([GOLD, BRONZE, SILVER]);
  });

  it("evicts the oldest medal once a seventh is earned", () => {
    const finishes = Array.from({ length: 8 }, (_, i) => ({ seasonNumber: i + 1, rank: 1 }));
    finishes[0].rank = 2; // oldest two are distinguishable from the rest
    finishes[1].rank = 3;
    const medals = medalsForFinishes(finishes);
    expect(medals).toHaveLength(MAX_NICKNAME_MEDALS);
    expect(medals).not.toContain(SILVER); // season 1 fell out of the window
    expect(medals).not.toContain(BRONZE); // season 2 fell out too
  });

  it("counts medals earned, not seasons elapsed", () => {
    // Three podiums, then four quiet seasons: still three medals.
    expect(
      medalsForFinishes([
        { seasonNumber: 1, rank: 1 },
        { seasonNumber: 2, rank: 2 },
        { seasonNumber: 3, rank: 3 },
      ]),
    ).toEqual([GOLD, SILVER, BRONZE]);
  });

  it("ignores finishes outside the podium", () => {
    expect(medalsForFinishes([{ seasonNumber: 1, rank: 4 }, { seasonNumber: 2, rank: 12 }])).toEqual([]);
  });
});

describe("desiredNickname", () => {
  it("appends medals to the end of the current nickname", () => {
    expect(desiredNickname(member("Grant"), [GOLD, BRONZE])).toBe(`Grant ${GOLD} ${BRONZE}`);
  });

  it("creates a nickname from the account name when the member has none", () => {
    expect(desiredNickname(member(null, "grant", "Grant"), [GOLD])).toBe(`Grant ${GOLD}`);
    expect(desiredNickname(member(null, "grant"), [GOLD])).toBe(`grant ${GOLD}`);
  });

  it("rebuilds rather than appends, fixing wrong order and stray medals", () => {
    expect(desiredNickname(member(`${SILVER} Grant ${GOLD}`), [GOLD, SILVER])).toBe(
      `Grant ${GOLD} ${SILVER}`,
    );
  });

  it("strips medals from a member who has not earned any", () => {
    expect(desiredNickname(member(`Grant ${GOLD} ${GOLD}`), [])).toBe("Grant");
  });

  it("leaves an untouched member with no nickname and no medals alone", () => {
    expect(desiredNickname(member(null), [])).toBeNull();
    expect(desiredNickname(member("Grant"), [])).toBe("Grant");
  });

  it("hands a member back to their account name once their last medal rolls off", () => {
    // The sweep created "Grant <medal>" for a member who had no nickname; when the medal ages
    // out, leaving a bare "Grant" nickname behind would pin them to that name forever.
    expect(desiredNickname(member(`Grant ${GOLD}`, "grant", "Grant"), [])).toBeNull();
    // A nickname they actually chose is theirs, and only loses its medals.
    expect(desiredNickname(member(`Sideways ${GOLD}`, "grant", "Grant"), [])).toBe("Sideways");
  });

  it("clears a nickname that was nothing but stolen medals", () => {
    expect(desiredNickname(member(`${GOLD}${SILVER}`), [])).toBeNull();
  });

  it("keeps the name and drops the medals when the two together would not fit", () => {
    const long = "A".repeat(NICKNAME_MAX_LENGTH - 1); // 31 chars; even one medal overflows
    expect(desiredNickname(member(long), [GOLD])).toBe(long);
    // ...and takes them back as soon as the name is short enough again.
    const shorter = "A".repeat(NICKNAME_MAX_LENGTH - 2);
    expect(desiredNickname(member(shorter), [GOLD])).toBe(`${shorter} ${GOLD}`);
  });

  it("fits a full six-medal set inside the length limit for a typical name", () => {
    const six = [GOLD, SILVER, BRONZE, GOLD, SILVER, BRONZE];
    const built = desiredNickname(member("Grant"), six);
    expect(built).toBe(`Grant ${six.join(" ")}`);
    expect(nicknameLength(built!)).toBeLessThanOrEqual(NICKNAME_MAX_LENGTH);
  });

  it("is exactly idempotent, so the daily sweep writes nothing on a normal day", () => {
    const cases: [string | null, string[]][] = [
      ["Grant", [GOLD, BRONZE, SILVER]],
      ["Grant", []],
      [null, [GOLD]],
      ["[CRL] Grant", [GOLD, SILVER]],
      ["Cool  Guy", [BRONZE]],
      [`${SILVER} Grant ${GOLD}`, [GOLD, SILVER]],
      [`Grant ${GOLD}`, []],
      ["A".repeat(31), [GOLD]],
      [null, []],
    ];
    for (const [nick, medals] of cases) {
      const first = desiredNickname(member(nick, "grant", "Grant"), medals);
      const second = desiredNickname(member(first, "grant", "Grant"), medals);
      expect(second).toBe(first);
    }
  });
});
