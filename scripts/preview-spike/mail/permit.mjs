const SESSION = /^[a-f0-9]{32}$/u;
const MESSAGE = /^[A-Za-z0-9-]{1,80}$/u;
const TTL = 120_000;

function valid(input, sessionId) {
  return (
    input !== null &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.keys(input).sort().join(",") === "generation,id,scopeHash,sessionId" &&
    input.sessionId === sessionId &&
    SESSION.test(sessionId) &&
    Number.isSafeInteger(input.generation) &&
    input.generation > 0 &&
    typeof input.id === "string" &&
    MESSAGE.test(input.id) &&
    typeof input.scopeHash === "string" &&
    /^[a-f0-9]{64}$/u.test(input.scopeHash)
  );
}

// Storage belongs to one private Durable Object named by the spike session ID. Only the
// authenticated private Worker may arm it; the guest never receives a DO or service binding.
export function createPermitOps(storage, sessionId, clock = () => Date.now()) {
  function matches(record, input) {
    return (
      valid(input, sessionId) &&
      record &&
      record.sessionId === sessionId &&
      record.generation === input.generation &&
      record.id === input.id &&
      record.scopeHash === input.scopeHash &&
      Number.isSafeInteger(record.attempts) &&
      record.attempts >= 0 &&
      record.attempts < 2 &&
      (record.state === "ready" || record.state === "accepted") &&
      Number.isFinite(record.expiresAt) &&
      record.expiresAt > clock()
    );
  }
  return {
    async arm(input) {
      if (!valid(input, sessionId) || !Number.isFinite(clock())) return false;
      return storage.transaction(async (tx) => {
        const previous = await tx.get("mailPermit");
        if (
          previous &&
          (previous.state === "in_flight" ||
            previous.state === "unknown" ||
            (previous.expiresAt > clock() && previous.attempts < 2))
        )
          return false;
        await tx.put("mailPermit", {
          ...input,
          attempts: 0,
          state: "ready",
          expiresAt: clock() + TTL,
        });
        return true;
      });
    },
    async peek(input) {
      return Boolean(matches(await storage.get("mailPermit"), input));
    },
    async consume(input) {
      return storage.transaction(async (tx) => {
        const record = await tx.get("mailPermit");
        if (!matches(record, input)) return false;
        await tx.put("mailPermit", {
          ...record,
          attempts: record.attempts + 1,
          state: "in_flight",
          priorState: record.state,
        });
        return true;
      });
    },
    async complete(input, outcome) {
      if (!valid(input, sessionId) || !["accepted", "unknown", "not_sent"].includes(outcome))
        return false;
      return storage.transaction(async (tx) => {
        const record = await tx.get("mailPermit");
        if (
          !record ||
          record.state !== "in_flight" ||
          record.sessionId !== sessionId ||
          record.generation !== input.generation ||
          record.id !== input.id ||
          record.scopeHash !== input.scopeHash
        )
          return false;
        if (record.priorState !== "ready" && record.priorState !== "accepted") return false;
        const { priorState, ...remaining } = record;
        await tx.put("mailPermit", {
          ...remaining,
          attempts: outcome === "not_sent" ? record.attempts - 1 : record.attempts,
          state: outcome === "not_sent" ? priorState : outcome,
        });
        return true;
      });
    },
    async status() {
      const record = await storage.get("mailPermit");
      if (!record) return null;
      const state =
        record.state === "in_flight" || record.state === "unknown"
          ? record.state
          : record.expiresAt <= clock()
            ? "expired"
            : record.attempts >= 2
              ? "exhausted"
              : record.state;
      return {
        id: record.id,
        generation: record.generation,
        state,
        attempts: record.attempts,
        expiresAt: record.expiresAt,
      };
    },
    async cleanup(input) {
      if (
        input === null ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).sort().join(",") !== "generation,sessionId" ||
        input.sessionId !== sessionId ||
        !SESSION.test(sessionId) ||
        !Number.isSafeInteger(input.generation) ||
        input.generation < 0
      )
        return false;
      return storage.transaction(async (tx) => {
        const record = await tx.get("mailPermit");
        if (!record) return true;
        if (
          record.sessionId !== sessionId ||
          record.generation !== input.generation ||
          !(
            (record.state === "ready" && record.attempts === 0) ||
            (record.state === "accepted" &&
              Number.isSafeInteger(record.attempts) &&
              record.attempts >= 1 &&
              record.attempts <= 2)
          )
        )
          return false;
        await tx.delete("mailPermit");
        return true;
      });
    },
  };
}
