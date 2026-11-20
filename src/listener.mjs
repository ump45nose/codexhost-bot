import { readdir } from "node:fs/promises";
import path from "node:path";
import { digest, readJson, saveJson } from "./store.mjs";
import { invoke, spawnFollower } from "./device.mjs";
import { postEvent } from "./webhook.mjs";

const DEFAULTS = { scanIntervalMs: 60_000, reconnectMs: 60_000, retryInitialMs: 5_000, retryMaxMs: 600_000 };

async function readDirSafe(dir) {
  try { return await readdir(dir, { withFileTypes: true }); }
  catch (e) { if (e.code === "ENOENT" || e.code === "ENOTDIR") return []; throw e; }
}

function sleepAbortable(ms, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => { clearTimeout(timer); resolve(false); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(true); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("close", resolve));
  child.stdin?.end();
  child.kill("SIGTERM");
  const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 3_000);
  timer.unref?.();
  await exited;
  clearTimeout(timer);
}

const readCursor = async (file) => {
  const data = await readJson(file);
  return Number.isSafeInteger(data?.after) && data.after >= 0 ? data.after : 0;
};
const writeCursor = (file, after) => saveJson(file, { after, updatedAt: new Date().toISOString() });

export async function discoverClients(config) {
  const deviceMap = new Map(config.devices.map((d) => [d.id, d]));
  const found = new Map();
  for (const acct of await readDirSafe(config.privateDir)) {
    if (!acct.isDirectory()) continue;
    const account = acct.name;
    const clientsRoot = path.join(config.privateDir, account, "clients");
    for (const dev of await readDirSafe(clientsRoot)) {
      const device = dev.isDirectory() ? deviceMap.get(dev.name) : undefined;
      if (!device) continue;
      const deviceDir = path.join(clientsRoot, device.id);
      const invName = `bot-${digest(`${account}:inventory:${device.dataDir}`).slice(0, 32)}`;
      for (const f of await readDirSafe(deviceDir)) {
        if (!f.isFile() || !f.name.endsWith(".json") || f.name.endsWith(".cursor.json")) continue;
        const clientName = f.name.slice(0, -5);
        if (clientName === "inventory" || clientName === invName) continue;
        const record = await readJson(path.join(deviceDir, f.name)).catch(() => undefined);
        if (!record?.tokenFile) continue;
        const key = `${account}/${device.id}/${clientName}`;
        found.set(key, {
          key, account, device, clientName, tokenFile: record.tokenFile,
          cursorFile: path.join(deviceDir, `${clientName}.cursor.json`),
        });
      }
    }
  }
  return found;
}

async function fetchTailCursor(device, tokenFile) {
  let after = 0;
  for (let i = 0; i < 1000; i++) {
    const page = await invoke(device, ["events", "--after", String(after), "--limit", "100"], tokenFile);
    const events = Array.isArray(page?.events) ? page.events : [];
    const lastId = events.at(-1)?.id;
    const next = Number.isSafeInteger(page?.cursor) && page.cursor >= after
      ? page.cursor
      : Number.isSafeInteger(lastId) && lastId > after ? lastId : after;
    if (events.length < 100 || next <= after) return next;
    after = next;
  }
  return after;
}

export async function seedCursors(config) {
  const seeded = [];
  for (const c of (await discoverClients(config)).values()) {
    if ((await readJson(c.cursorFile)) !== undefined) continue;
    const after = await fetchTailCursor(c.device, c.tokenFile);
    await writeCursor(c.cursorFile, after);
    seeded.push({ account: c.account, device: c.device.id, client: c.clientName, after });
  }
  return { seeded };
}

function createTaskLookup(config) {
  const cache = new Map();
  return async (account, threadId) => {
    if (typeof threadId !== "string" || !threadId) return undefined;
    const key = `${account}\0${threadId}`;
    if (cache.has(key)) return cache.get(key);
    const tasksRoot = path.join(config.privateDir, account, "tasks");
    for (const bot of await readDirSafe(tasksRoot)) {
      if (!bot.isDirectory()) continue;
      const botDir = path.join(tasksRoot, bot.name);
      for (const f of await readDirSafe(botDir)) {
        if (!f.isFile() || !f.name.endsWith(".json")) continue;
        const task = await readJson(path.join(botDir, f.name)).catch(() => undefined);
        if (task?.start?.threadId) cache.set(`${account}\0${task.start.threadId}`, bot.name);
      }
    }
    return cache.get(key);
  };
}

function createFollower(config, client, findBotForThread, { reconnectMs, retryInitialMs, retryMaxMs, log }) {
  const stopCtrl = new AbortController();
  const base = { account: client.account, device: client.device.id, client: client.clientName };
  let stopped = false, child = null, childAbort = null, drainPromise = Promise.resolve();
  let queue = [], draining = false, currentAfter = 0;

  const advance = async (id) => { await writeCursor(client.cursorFile, id); currentAfter = id; };

  async function handleEvent(event, signal) {
    if (!Number.isSafeInteger(event?.id) || event.id <= currentAfter) return;
    const botId = await findBotForThread(client.account, event.threadId);
    if (stopped || signal.aborted) return;
    if (!botId) return advance(event.id);
    const bindingFile = path.join(config.privateDir, client.account, "origins", botId, "binding.json");
    let delay = retryInitialMs;
    while (!stopped && !signal.aborted) {
      const binding = await readJson(bindingFile).catch(() => undefined);
      if (stopped || signal.aborted) return;
      if (!binding?.webhook?.url || !binding?.webhook?.key) {
        log("warn", "webhook_missing", { ...base, eventId: event.id });
        return advance(event.id);
      }
      const outcome = await postEvent(binding.webhook, client.clientName, event);
      if (stopped || signal.aborted) return;
      if (outcome === "delivered" || outcome === "drop") {
        log(outcome === "delivered" ? "info" : "error", "event_pushed", { ...base, eventId: event.id, outcome });
        return advance(event.id);
      }
      log("warn", "webhook_retry", { ...base, eventId: event.id, retryInMs: delay });
      if (!(await sleepAbortable(delay, signal))) return;
      delay = Math.min(delay * 2, retryMaxMs);
    }
  }

  async function startChild() {
    if (stopped) return;
    let startAfter, proc;
    try {
      currentAfter = await readCursor(client.cursorFile);
      if (stopped) return;
      startAfter = currentAfter;
      proc = spawnFollower(client.device, startAfter, client.tokenFile);
    } catch (err) {
      log("error", "follower_error", { ...base, code: err?.code ?? "START_ERROR", restartInMs: reconnectMs });
      if (await sleepAbortable(reconnectMs, stopCtrl.signal)) startChild();
      return;
    }
    const localAbort = new AbortController();
    childAbort = localAbort;
    const onStop = () => localAbort.abort();
    stopCtrl.signal.addEventListener("abort", onStop, { once: true });

    child = proc; queue = []; draining = false;
    let expired = false, expiredPromise = null, closed = false, buffer = "";

    function triggerExpired() {
      if (expired || stopped) return;
      expired = true; queue = []; localAbort.abort();
      log("error", "cursor_expired", { ...base, after: currentAfter });
      expiredPromise = (async () => {
        try {
          await stopChild(proc);
          await drainPromise;
          await advance(0);
        } catch (err) {
          log("error", "cursor_reset_failed", { ...base, code: err?.code ?? "CURSOR_ERROR" });
        }
      })();
    }

    function pump() {
      if (draining) return;
      draining = true;
      drainPromise = (async () => {
        try {
          while (queue.length && !stopped && !localAbort.signal.aborted)
            await handleEvent(queue.shift(), localAbort.signal);
        } catch (err) {
          queue = [];
          localAbort.abort();
          log("error", "event_error", { ...base, code: err?.code ?? "EVENT_ERROR" });
          stopChild(proc).catch(() => {});
        } finally {
          draining = false;
          if (queue.length && !stopped && !localAbort.signal.aborted) pump();
        }
      })();
    }

    function processLine(line) {
      let parsed;
      try { parsed = JSON.parse(line); }
      catch { if (line.includes("CURSOR_EXPIRED")) triggerExpired(); return; }
      if (parsed?.code === "CURSOR_EXPIRED" || parsed?.error?.code === "CURSOR_EXPIRED") return triggerExpired();
      queue.push(parsed);
      pump();
    }

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) if (raw.trim()) processLine(raw.trim());
    });
    proc.stdout.on("end", () => { if (buffer.trim()) processLine(buffer.trim()); buffer = ""; });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => { if (chunk.includes("CURSOR_EXPIRED")) triggerExpired(); });

    async function onExit(code, signal, err) {
      if (closed) return;
      closed = true;
      stopCtrl.signal.removeEventListener("abort", onStop);
      if (child === proc) child = null;
      try {
        if (expiredPromise) await expiredPromise;
        await drainPromise;
        if (stopped) return;
        if (expired) {
          if (startAfter === 0 && !(await sleepAbortable(reconnectMs, stopCtrl.signal))) return;
          return startChild();
        }
        log("warn", err ? "follower_error" : "follower_exited", {
          ...base, ...(err ? { code: err.code ?? "SPAWN_ERROR" } : { exitCode: code, signal }), restartInMs: reconnectMs,
        });
      } catch (exitErr) {
        log("error", "follower_error", { ...base, code: exitErr?.code ?? "EXIT_ERROR", restartInMs: reconnectMs });
      }
      if (!stopped && (await sleepAbortable(reconnectMs, stopCtrl.signal))) startChild();
    }

    proc.once("error", (err) => onExit(null, null, err));
    proc.once("close", (code, sig) => onExit(code, sig, null));
  }

  startChild();
  return {
    async stop() {
      stopped = true; stopCtrl.abort(); childAbort?.abort();
      await stopChild(child);
      await drainPromise;
    },
  };
}

export async function listen(config, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const stderr = options.stderr ?? process.stderr;
  const log = (level, event, fields = {}) =>
    stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level, event, ...fields })}\n`);
  const findBotForThread = createTaskLookup(config);
  const followers = new Map();
  let stopped = false, scanning = false;

  async function syncClients() {
    if (stopped || scanning) return;
    scanning = true;
    try {
      const discovered = await discoverClients(config);
      for (const [key, follower] of followers) {
        if (!discovered.has(key)) { followers.delete(key); await follower.stop(); }
      }
      for (const [key, client] of discovered) {
        if (!followers.has(key) && !stopped)
          followers.set(key, createFollower(config, client, findBotForThread, { ...cfg, log }));
      }
    } catch (e) {
      log("error", "scan_failed", { code: e.code ?? "SCAN_ERROR" });
    } finally { scanning = false; }
  }

  await syncClients();
  if (!options.signal?.aborted) {
    await new Promise((resolve) => {
      const timer = setInterval(syncClients, cfg.scanIntervalMs);
      options.signal?.addEventListener("abort", () => { clearInterval(timer); resolve(); }, { once: true });
    });
  }
  stopped = true;
  await Promise.all([...followers.values()].map((f) => f.stop()));
}
