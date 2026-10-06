import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// discordFetch's retry loop is the only part of rest.ts with real logic in it, and it is what
// failed live on 2026-10-06 (see its own comment). Everything here drives it through a fake
// global fetch; no module under test is mocked.
const { discordFetch, DiscordApiError } = await import("./rest");

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

// Replies are consumed in order; the last one repeats, so a test only has to spell out the
// prefix it cares about.
function respondWith(replies: Reply[]) {
  let i = 0;
  const fetchMock = vi.fn(async () => {
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {});
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      headers: new Headers(reply.headers ?? {}),
      text: async () => text,
      json: async () => JSON.parse(text),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// Real sleeps would make the retry tests take tens of seconds. runAllTimersAsync drains the
// chain of setTimeouts the loop schedules, flushing microtasks between each one.
async function settle<T>(promise: Promise<T>): Promise<T> {
  const drained = vi.runAllTimersAsync();
  const result = await promise;
  await drained;
  return result;
}

async function settleRejection(promise: Promise<unknown>): Promise<unknown> {
  const drained = vi.runAllTimersAsync();
  const err = await promise.then(
    () => {
      throw new Error("expected discordFetch to reject");
    },
    (e) => e,
  );
  await drained;
  return err;
}

const rateLimited = (retryAfter: number): Reply => ({ status: 429, body: { retry_after: retryAfter } });

beforeEach(() => {
  vi.stubEnv("DISCORD_BOT_TOKEN", "test-token");
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("discordFetch", () => {
  it("returns the parsed body on success and null on 204", async () => {
    respondWith([{ status: 200, body: { id: "m1" } }]);
    expect(await settle(discordFetch("/channels/c/messages", { method: "POST" }))).toEqual({ id: "m1" });

    respondWith([{ status: 204 }]);
    expect(await settle(discordFetch("/channels/c/messages/m1", { method: "DELETE" }))).toBeNull();
  });

  it("waits out a 429 and returns the retry's result", async () => {
    const fetchMock = respondWith([rateLimited(1), { status: 200, body: { id: "m1" } }]);
    expect(await settle(discordFetch("/channels/c/messages", { method: "POST" }))).toEqual({ id: "m1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // The live regression: six joins saturated one channel's bucket, which kept reopening in
  // roughly one-second steps. The old three-retry budget ran out mid-burst and threw, stranding
  // the series. Six is enough to outlast it.
  it("survives a burst that outlasts the old three-retry budget", async () => {
    const fetchMock = respondWith([
      rateLimited(1),
      rateLimited(1),
      rateLimited(1),
      rateLimited(1),
      rateLimited(1),
      rateLimited(1),
      { status: 200, body: { id: "m1" } },
    ]);
    expect(await settle(discordFetch("/channels/c/messages", { method: "POST" }))).toEqual({ id: "m1" });
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("gives up once the retry count is exhausted", async () => {
    const fetchMock = respondWith([rateLimited(1)]);
    const err = await settleRejection(discordFetch("/channels/c/messages", { method: "POST" }));
    expect(err).toBeInstanceOf(DiscordApiError);
    expect((err as InstanceType<typeof DiscordApiError>).status).toBe(429);
    // Six retries plus the attempt that finally throws.
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  // A global rate limit hands back a wait long enough to spend the whole budget in one go, so it
  // must not get six of them — one sleep, then out, the same as before the budget existed.
  it("stops after a single sleep when one wait spends the whole budget", async () => {
    const fetchMock = respondWith([rateLimited(30)]);
    await settleRejection(discordFetch("/channels/c/messages", { method: "POST" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Discord sends Cloudflare-level limits in the header instead of the JSON body.
  it("reads retry_after from the retry-after header when the body has none", async () => {
    const fetchMock = respondWith([
      { status: 429, body: "<html>rate limited</html>", headers: { "retry-after": "2" } },
      { status: 200, body: { id: "m1" } },
    ]);
    expect(await settle(discordFetch("/channels/c/messages", { method: "POST" }))).toEqual({ id: "m1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never retries a non-429 and surfaces Discord's error code", async () => {
    const fetchMock = respondWith([{ status: 404, body: { code: 10007, message: "Unknown Member" } }]);
    const err = await settleRejection(discordFetch("/guilds/g/members/u", { method: "PATCH" }));
    expect(err).toBeInstanceOf(DiscordApiError);
    expect((err as InstanceType<typeof DiscordApiError>).status).toBe(404);
    expect((err as InstanceType<typeof DiscordApiError>).code).toBe(10007);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a null code when the error body isn't JSON", async () => {
    respondWith([{ status: 502, body: "<html>bad gateway</html>" }]);
    const err = await settleRejection(discordFetch("/channels/c/messages", { method: "POST" }));
    expect((err as InstanceType<typeof DiscordApiError>).code).toBeNull();
    expect((err as Error).message).toContain("502");
  });
});
