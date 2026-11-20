import { afterEach, describe, expect, it, vi } from "vitest";
import { compactBody, postEvent } from "../src/webhook.mjs";

const baseEvent = {
  id: 42,
  time: "2026-11-21T00:00:00.000Z",
  type: "watch",
  threadId: "thread-one",
  outcome: "completed",
  turnId: "turn-one",
  harnessId: "codex",
  deepLink: "codex://threads/thread-one",
  refs: ["codexhost-bot://task/abc"],
  note: "Finished",
};

describe("compactBody", () => {
  it("matches fork field mapping, omits undefined optionals, and strips extra fields", () => {
    expect(compactBody({ ...baseEvent, extra: "ignored" })).toBe(JSON.stringify(baseEvent));
    const minimal = { id: 7, time: baseEvent.time, type: "watch", threadId: "t2", outcome: "failed", deepLink: "codex://t2" };
    expect(compactBody({ ...minimal, extra: true })).toBe(JSON.stringify(minimal));
  });

  it.each([
    ["refs", { refs: ["r".repeat(4100)], note: "keep" }, ["refsOmitted"], ["note", "deepLink"]],
    ["refs+note", { refs: ["r".repeat(100)], note: "你".repeat(1500) }, ["refsOmitted", "noteOmitted"], ["deepLink"]],
    ["refs+note+deepLink", { refs: ["r".repeat(50)], note: "n".repeat(50), deepLink: `codex://t/${"d".repeat(4100)}` }, ["refsOmitted", "noteOmitted", "deepLinkOmitted"], []],
  ])("trims %s when over 4096 UTF-8 bytes", (_label, patch, omitted, kept) => {
    const body = compactBody({ ...baseEvent, ...patch });
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(4_096);
    const parsed = JSON.parse(body);
    expect(parsed.id).toBe(baseEvent.id);
    for (const flag of omitted) expect(parsed[flag]).toBe(true);
    for (const field of ["refs", "note", "deepLink"]) {
      if (kept.includes(field)) expect(parsed[field]).toBeDefined();
      else expect(parsed[field]).toBeUndefined();
    }
  });
});

describe("postEvent", () => {
  const webhook = { url: "https://api2.cursor.sh/automations/webhook/a1", key: "secret-key" };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends POST with expected headers, compacted body, redirect error, and 20s timeout", async () => {
    const fakeSignal = new AbortController().signal;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(fakeSignal);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const event = { ...baseEvent, extra: "stripped" };
    expect(await postEvent(webhook, "client-one", event)).toBe("delivered");
    expect(timeoutSpy).toHaveBeenCalledWith(20_000);
    expect(fetchMock).toHaveBeenCalledWith(webhook.url, {
      method: "POST",
      redirect: "error",
      signal: fakeSignal,
      headers: {
        authorization: "Bearer secret-key",
        "content-type": "application/json",
        "idempotency-key": "client-one:42",
      },
      body: compactBody(event),
    });
  });

  it.each([
    [200, "delivered"], [201, "delivered"], [204, "delivered"], [299, "delivered"],
    [429, "retry"], [500, "retry"], [503, "retry"],
    [302, "drop"], [400, "drop"], [401, "drop"], [403, "drop"], [404, "drop"], [422, "drop"],
  ])("classifies HTTP %i as %s", async (status, expected) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status })));
    expect(await postEvent(webhook, "client-one", baseEvent)).toBe(expected);
  });

  it.each([
    ["network error", new TypeError("fetch failed")],
    ["timeout", new DOMException("aborted", "TimeoutError")],
  ])("classifies %s as retry", async (_label, error) => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw error; }));
    expect(await postEvent(webhook, "client-one", baseEvent)).toBe("retry");
  });
});
