import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { followerSpawnSpec } from "../src/device.mjs";
import { listen, seedCursors } from "../src/listener.mjs";
import { digest, readJson, saveJson } from "../src/store.mjs";
import { run } from "../src/cli.mjs";

const SECRET_TOKEN = "tok-super-secret-value-123";
const SECRET_KEY = "wh-secret-api-key-456";
const tempDirs = [];

async function waitFor(fn, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await Promise.resolve().then(fn).catch(() => false);
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("Timed out waiting for condition");
}

function createLogSink() {
  const chunks = [];
  return {
    stream: new Writable({ write(c, _e, cb) { chunks.push(c.toString("utf8")); cb(); } }),
    raw: () => chunks.join(""),
    entries: () => chunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
}

async function createWebhookServer(handler) {
  const received = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const item = { headers: req.headers, body: JSON.parse(body) };
      received.push(item);
      res.writeHead(handler ? handler(item, received.length) : 200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}/webhook-secret-path`,
    received,
    close: () => new Promise((r) => server.close(r)),
  };
}

async function setupFixture(fakeCliSource, webhookUrl) {
  const parent = path.resolve("outputs/.bot-integration-tests");
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(path.join(parent, "listener-"));
  tempDirs.push(dir);
  const privateDir = path.join(dir, "private");
  const cliPath = path.join(dir, "fake-codexhost.mjs");
  const tokenFile = path.join(dir, "client.token");
  const grokPkg = path.join(dir, "grok-pkg.json");
  await writeFile(cliPath, fakeCliSource, { mode: 0o755 });
  await writeFile(tokenFile, `${SECRET_TOKEN}\n`, { mode: 0o600 });
  await saveJson(grokPkg, { version: "0.79.4" });
  const config = {
    version: 1, privateDir, exportDir: path.join(dir, "exports"), commandPath: "/usr/local/bin/codexhost-bot",
    devices: [{
      id: "dev1", transport: "local", cli: cliPath, node: process.execPath,
      dataDir: path.join(dir, "host-data"), privateDir: path.join(dir, "host-private"),
    }],
    grok: {
      version: "0.79.4", controller: path.join(dir, "c.mjs"),
      credentials: path.join(dir, "cred.json"), machine: path.join(dir, "m.json"), packageJson: grokPkg,
    },
  };
  const configFile = path.join(dir, "config.json");
  const clientDir = path.join(privateDir, "acct1", "clients", "dev1");
  await saveJson(configFile, config);
  await saveJson(path.join(clientDir, "bot-alpha.json"), { name: "bot-alpha", token: SECRET_TOKEN, tokenFile });
  await saveJson(path.join(privateDir, "acct1", "tasks", "botA", `${"a".repeat(32)}.json`), {
    id: "a".repeat(32), account: "acct1", botId: "botA", device: "dev1", start: { threadId: "thread-own" },
  });
  if (webhookUrl) {
    await saveJson(path.join(privateDir, "acct1", "origins", "botA", "binding.json"), {
      account: "acct1", botId: "botA", state: "verified", webhook: { url: webhookUrl, key: SECRET_KEY },
    });
  }
  return { dir, config, configFile, clientDir, cursorFile: path.join(clientDir, "bot-alpha.cursor.json") };
}

function assertCleanLogs(logs, webhookUrl) {
  const entries = logs.entries();
  const raw = logs.raw();
  expect(raw).not.toContain(SECRET_TOKEN);
  expect(raw).not.toContain(SECRET_KEY);
  if (webhookUrl) expect(raw).not.toContain(webhookUrl);
  for (const e of entries) expect(typeof e.level === "string" && typeof e.event === "string").toBe(true);
  return entries;
}

afterEach(async () => { while (tempDirs.length) await rm(tempDirs.pop(), { recursive: true, force: true }); });

describe("listener", () => {
  it("C1.5 & C1.6 & C1.8: pushes matching events, skips foreign threads, persists cursor across restart", async () => {
    const server = await createWebhookServer();
    try {
      const fx = await setupFixture(`#!/usr/bin/env node
const after = Number(process.argv[process.argv.indexOf("--after") + 1] ?? 0);
const all = [
  { id: 1, time: "t1", type: "watch", threadId: "thread-own", outcome: "completed", deepLink: "x://1" },
  { id: 2, time: "t2", type: "watch", threadId: "thread-other", outcome: "completed", deepLink: "x://2" },
  { id: 3, time: "t3", type: "watch", threadId: "thread-own", outcome: "completed", deepLink: "x://3" },
];
for (const ev of all) if (ev.id > after && ev.id <= (after === 0 ? 2 : 3)) process.stdout.write(JSON.stringify(ev) + "\\n");
setInterval(() => {}, 10_000);
`, server.url);
      const logs = createLogSink();
      const c1 = new AbortController();
      const r1 = listen(fx.config, { signal: c1.signal, reconnectMs: 50, retryInitialMs: 30, stderr: logs.stream });
      await waitFor(async () => (await readJson(fx.cursorFile))?.after === 2);
      expect(server.received).toHaveLength(1);
      expect(server.received[0].headers["idempotency-key"]).toBe("bot-alpha:1");
      expect((await stat(fx.cursorFile)).mode & 0o777).toBe(0o600);
      c1.abort(); await r1;

      const c2 = new AbortController();
      const r2 = listen(fx.config, { signal: c2.signal, reconnectMs: 50, retryInitialMs: 30, stderr: logs.stream });
      await waitFor(async () => (await readJson(fx.cursorFile))?.after === 3);
      expect(server.received.map((r) => r.body.id)).toEqual([1, 3]);
      c2.abort(); await r2;
      assertCleanLogs(logs, server.url);
    } finally { await server.close(); }
  });

  it("C1.7: retries on 429/500 without advancing cursor or overtaking queued events", async () => {
    const server = await createWebhookServer((item, n) => (item.body.id === 1 && n === 1 ? 429 : item.body.id === 1 && n === 2 ? 500 : 200));
    try {
      const fx = await setupFixture(`#!/usr/bin/env node
process.stdout.write(JSON.stringify({ id: 1, time: "t1", type: "watch", threadId: "thread-own", outcome: "completed", deepLink: "x://1" }) + "\\n");
process.stdout.write(JSON.stringify({ id: 2, time: "t2", type: "watch", threadId: "thread-own", outcome: "completed", deepLink: "x://2" }) + "\\n");
setInterval(() => {}, 10_000);
`, server.url);
      const logs = createLogSink();
      const ctrl = new AbortController();
      const running = listen(fx.config, { signal: ctrl.signal, retryInitialMs: 40, retryMaxMs: 120, stderr: logs.stream });
      await waitFor(() => server.received.length >= 2);
      expect(await readJson(fx.cursorFile)).toBeUndefined();
      expect(server.received.every((r) => r.body.id === 1)).toBe(true);
      await waitFor(async () => (await readJson(fx.cursorFile))?.after === 2);
      expect(server.received.map((r) => r.body.id)).toEqual([1, 1, 1, 2]);
      ctrl.abort(); await running;
      assertCleanLogs(logs, server.url);
    } finally { await server.close(); }
  });

  it("C1.9: resets cursor to 0 on CURSOR_EXPIRED, logs error, and restarts from 0", async () => {
    const server = await createWebhookServer();
    try {
      const fx = await setupFixture(`#!/usr/bin/env node
if (Number(process.argv[process.argv.indexOf("--after") + 1] ?? 0) > 0) {
  process.stderr.write(JSON.stringify({ error: { code: "CURSOR_EXPIRED" } }) + "\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ id: 5, time: "t5", type: "watch", threadId: "thread-own", outcome: "completed", deepLink: "x://5" }) + "\\n");
setInterval(() => {}, 10_000);
`, server.url);
      await saveJson(fx.cursorFile, { after: 99, updatedAt: new Date().toISOString() });
      const logs = createLogSink();
      const ctrl = new AbortController();
      const running = listen(fx.config, { signal: ctrl.signal, reconnectMs: 50, stderr: logs.stream });
      await waitFor(async () => (await readJson(fx.cursorFile))?.after === 5);
      expect(server.received.map((r) => r.body.id)).toEqual([5]);
      ctrl.abort(); await running;
      expect(assertCleanLogs(logs, server.url).some((e) => e.level === "error" && e.event === "cursor_expired")).toBe(true);
    } finally { await server.close(); }
  });

  it("C1.10: restarts follower automatically after child exit", async () => {
    const server = await createWebhookServer();
    try {
      const fx = await setupFixture(`#!/usr/bin/env node
import fs from "node:fs";
const f = process.env.CODEXHOST_DATA_DIR + ".count";
const n = (fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : 0) + 1;
fs.writeFileSync(f, String(n));
if (n === 1) process.exit(2);
process.stdout.write(JSON.stringify({ id: 7, time: "t7", type: "watch", threadId: "thread-own", outcome: "completed", deepLink: "x://7" }) + "\\n");
setInterval(() => {}, 10_000);
`, server.url);
      const logs = createLogSink();
      const ctrl = new AbortController();
      const running = listen(fx.config, { signal: ctrl.signal, reconnectMs: 40, stderr: logs.stream });
      await waitFor(async () => (await readJson(fx.cursorFile))?.after === 7);
      ctrl.abort(); await running;
      expect(assertCleanLogs(logs, server.url).some((e) => e.event === "follower_exited" && e.exitCode === 2)).toBe(true);
    } finally { await server.close(); }
  });

  it("C1.11: exits 0 on SIGTERM with no lingering follower child process", async () => {
    const fx = await setupFixture(`#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(process.env.CODEXHOST_DATA_DIR + ".pid", String(process.pid));
setInterval(() => {}, 10_000);
`);
    const pidFile = `${fx.config.devices[0].dataDir}.pid`;
    const child = spawn(process.execPath, [fileURLToPath(new URL("../src/cli.mjs", import.meta.url)), "listen"], {
      env: { ...process.env, CODEXHOST_BOT_CONFIG: fx.configFile }, stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise((r) => child.once("close", (code) => r(code)));
    const followerPid = await waitFor(async () => Number(await readFile(pidFile, "utf8")));
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(() => process.kill(followerPid, 0)).toThrow();
  });

  it("C1.12: cursor seed writes tail cursor only for clients without cursor files and skips inventory", async () => {
    const fx = await setupFixture(`#!/usr/bin/env node
import fs from "node:fs";
const token = fs.readFileSync(process.env.CODEXHOST_CLIENT_TOKEN_FILE, "utf8").trim();
if (process.argv[2] === "events") {
  const events = token === "tok-empty" ? [] : [{ id: 10 }, { id: 42 }];
  process.stdout.write(JSON.stringify({ events, cursor: events.length ? 42 : 0 }));
} else process.exit(1);
`);
    const emptyToken = path.join(fx.dir, "empty.token");
    await writeFile(emptyToken, "tok-empty\n", { mode: 0o600 });
    await saveJson(path.join(fx.clientDir, "bot-empty.json"), { name: "bot-empty", token: "tok-empty", tokenFile: emptyToken });
    await saveJson(path.join(fx.clientDir, "bot-existing.json"), { name: "bot-existing", token: SECRET_TOKEN, tokenFile: path.join(fx.dir, "client.token") });
    await saveJson(path.join(fx.clientDir, "bot-existing.cursor.json"), { after: 7, updatedAt: "2026-01-01T00:00:00.000Z" });
    const invName = `bot-${digest(`acct1:inventory:${fx.config.devices[0].dataDir}`).slice(0, 32)}`;
    await saveJson(path.join(fx.clientDir, `${invName}.json`), { name: invName, token: SECRET_TOKEN, tokenFile: path.join(fx.dir, "client.token") });

    const result = await run(["cursor", "seed"], { ...process.env, CODEXHOST_BOT_CONFIG: fx.configFile });
    expect(result.seeded.sort((a, b) => a.client.localeCompare(b.client))).toEqual([
      { account: "acct1", device: "dev1", client: "bot-alpha", after: 42 },
      { account: "acct1", device: "dev1", client: "bot-empty", after: 0 },
    ]);
    expect((await readJson(fx.cursorFile)).after).toBe(42);
    expect((await readJson(path.join(fx.clientDir, "bot-existing.cursor.json"))).after).toBe(7);
    expect(await readJson(path.join(fx.clientDir, `${invName}.cursor.json`))).toBeUndefined();
    expect(await seedCursors(fx.config)).toEqual({ seeded: [] });
  });

  it("C1.13: constructs SSH follower command with env -u (including CODEXHOST_REMOTE_SSH_MANAGED) and stdin watchdog", () => {
    const spec = followerSpawnSpec({
      id: "mac1", transport: "ssh", cli: "/opt/codexhost/bin/codexhost", node: "/opt/node/bin/node",
      dataDir: "/Users/me/.codexhost", privateDir: "/Users/me/.codexhost-bot",
      ssh: { destination: "me@mac1.local", identityFile: "/home/nas/.ssh/id_ed25519" },
    }, 123, "/Users/me/.codexhost-bot/clients/bot-a.token");
    expect(spec.command).toBe("ssh");
    expect(spec.args.slice(0, -1)).toEqual([
      "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes",
      "-i", "/home/nas/.ssh/id_ed25519", "me@mac1.local",
    ]);
    const remote = spec.args.at(-1);
    for (const key of [
      "CODEXHOST_RUNTIME_ENDPOINT", "CODEXHOST_RUNTIME_TOKEN", "CODEXHOST_THREAD_ID",
      "CODEX_THREAD_ID", "CODEXHOST_CLIENT_TOKEN", "CODEXHOST_REMOTE_SSH_MANAGED",
    ]) expect(remote).toContain(`'-u' '${key}'`);
    expect(remote).toContain("'CODEXHOST_DATA_DIR=/Users/me/.codexhost'");
    expect(remote).toContain("'CODEXHOST_CLIENT_TOKEN_FILE=/Users/me/.codexhost-bot/clients/bot-a.token'");
    expect(remote).toContain("'/opt/codexhost/bin/codexhost' 'events' '--after' '123' '--follow' 'true'");
    expect(remote.endsWith(" & p=$!; cat >/dev/null; pkill -TERM -P $p; kill $p")).toBe(true);

    const local = followerSpawnSpec(
      { id: "l1", transport: "local", cli: "/usr/local/bin/codexhost", node: "/usr/local/bin/node", dataDir: "/var/lib/codexhost" },
      0, "/var/lib/bot.token",
      { PATH: "/usr/bin", CODEXHOST_CLIENT_TOKEN: "leak", CODEXHOST_REMOTE_SSH_MANAGED: "1", CODEX_THREAD_ID: "old" },
    );
    expect(local.command).toBe("/usr/local/bin/codexhost");
    expect(local.args).toEqual(["events", "--after", "0", "--follow", "true"]);
    expect(local.env.CODEXHOST_CLIENT_TOKEN).toBeUndefined();
    expect(local.env.CODEXHOST_REMOTE_SSH_MANAGED).toBeUndefined();
    expect(local.env.CODEX_THREAD_ID).toBeUndefined();
    expect(local.env.CODEXHOST_DATA_DIR).toBe("/var/lib/codexhost");
    expect(local.env.CODEXHOST_CLIENT_TOKEN_FILE).toBe("/var/lib/bot.token");
  });
});
