const MAX_BODY_BYTES = 4_096;
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Keeps the body small: the target shows bots only its first few KB. Only the documented
 * event fields are sent; refs, then the note, then the deep link give way to stay in bounds,
 * while the event id used for deduplication is always kept.
 */
export function compactBody(event) {
  const payload = {
    id: event.id,
    time: event.time,
    type: event.type,
    threadId: event.threadId,
    outcome: event.outcome,
    ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
    ...(event.harnessId !== undefined ? { harnessId: event.harnessId } : {}),
    deepLink: event.deepLink,
    ...(event.refs !== undefined ? { refs: event.refs } : {}),
    ...(event.note !== undefined ? { note: event.note } : {}),
  };
  const fits = () => Buffer.byteLength(JSON.stringify(payload)) <= MAX_BODY_BYTES;
  if (fits()) return JSON.stringify(payload);
  if ("refs" in payload) {
    delete payload.refs;
    payload.refsOmitted = true;
  }
  if (!fits() && "note" in payload) {
    delete payload.note;
    payload.noteOmitted = true;
  }
  if (!fits()) {
    delete payload.deepLink;
    payload.deepLinkOmitted = true;
  }
  return JSON.stringify(payload);
}

/** Posts one Host event to a Grok Bot webhook and classifies the outcome. */
export async function postEvent(webhook, clientName, event) {
  try {
    const response = await fetch(webhook.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${webhook.key}`,
        "content-type": "application/json",
        "idempotency-key": `${clientName}:${event.id}`,
      },
      body: compactBody(event),
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.status >= 200 && response.status < 300) return "delivered";
    if (response.status === 429 || response.status >= 500) return "retry";
    return "drop";
  } catch {
    return "retry";
  }
}
