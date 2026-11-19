/** Fixed Stripe balance-transaction reader. No provider credential or raw payload crosses this boundary. */
const identifier = (value: unknown, prefix: string): value is string =>
  typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_]{1,128}$`, "u").test(value);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("stripe_growth_invalid");
  return value as Record<string, unknown>;
};
export function createGrowthPaymentReader(input: {
  credential: string;
  accountId: string;
  mode: "test" | "live";
  fetcher: (request: Request) => Promise<Response>;
  resolveCustomer: (customer: string) => Promise<string | null>;
}) {
  async function get(path: string, params?: URLSearchParams) {
    const url = new URL(`https://api.stripe.com/v1/${path}`);
    if (params) url.search = params.toString();
    const response = await input.fetcher(
      new Request(url, {
        headers: { authorization: `Bearer ${input.credential}` },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("stripe_growth_unavailable");
    }
    if (!response.body) throw new Error("stripe_growth_invalid");
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 2_000_000) {
          await reader.cancel();
          throw new Error("stripe_growth_invalid");
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
    } catch {
      throw new Error("stripe_growth_invalid");
    }
  }
  return {
    async readGrowthPaymentPage(page: { cursor: string | null; limit: number }) {
      if (
        !page ||
        !Number.isInteger(page.limit) ||
        page.limit < 1 ||
        page.limit > 200 ||
        (page.cursor !== null && !identifier(page.cursor, "txn")) ||
        !identifier(input.accountId, "acct") ||
        !input.credential.startsWith(input.mode === "test" ? "sk_test_" : "sk_live_")
      )
        throw new TypeError("invalid growth payment page");
      const account = await get("account");
      if (account["id"] !== input.accountId) throw new Error("stripe_growth_scope_conflict");
      const params = new URLSearchParams({
        limit: String(Math.min(page.limit, 100)),
        "expand[]": "data.source",
      });
      if (page.cursor) params.set("starting_after", page.cursor);
      const result = await get("balance_transactions", params);
      if (
        !Array.isArray(result["data"]) ||
        result["data"].length > Math.min(page.limit, 100) ||
        typeof result["has_more"] !== "boolean"
      )
        throw new Error("stripe_growth_invalid");
      const facts = [];
      let last: string | null = null;
      let watermark: string | null = null;
      for (const raw of result["data"]) {
        const transaction = object(raw);
        const transactionId = transaction["id"];
        if (!identifier(transactionId, "txn")) throw new Error("stripe_growth_invalid");
        last = transactionId;
        const type = transaction["type"];
        const amount = transaction["amount"];
        if (
          !Number.isSafeInteger(amount) ||
          typeof transaction["created"] !== "number" ||
          !Number.isSafeInteger(transaction["created"]) ||
          typeof transaction["currency"] !== "string" ||
          !/^[a-z]{3}$/u.test(transaction["currency"]) ||
          !["pending", "available"].includes(String(transaction["status"]))
        )
          throw new Error("stripe_growth_invalid");
        const occurred = new Date(transaction["created"] * 1000).toISOString();
        watermark ??= occurred;
        const sourceValue = transaction["source"];
        const source =
          typeof sourceValue === "object" && sourceValue !== null ? object(sourceValue) : null;
        const sourceType = source?.["object"];
        const effect =
          (type === "charge" || type === "payment") && (amount as number) > 0
            ? "received"
            : (type === "refund" || type === "payment_refund") && (amount as number) < 0
              ? "refunded"
              : type === "adjustment" && sourceType === "dispute" && (amount as number) < 0
                ? "withdrawn"
                : type === "adjustment" && sourceType === "dispute" && (amount as number) > 0
                  ? "restored"
                  : null;
        if (!effect) continue;
        if (
          !source ||
          (effect === "withdrawn" || effect === "restored"
            ? !identifier(source["id"], "du")
            : effect === "received"
              ? !identifier(source["id"], "ch") && !identifier(source["id"], "py")
              : !identifier(source["id"], "re"))
        )
          throw new Error("stripe_growth_invalid");
        let charge = source;
        if (sourceType !== "charge") {
          const chargeId = source["charge"];
          if (!identifier(chargeId, "ch") && !identifier(chargeId, "py"))
            throw new Error("stripe_growth_invalid");
          charge = await get(`charges/${encodeURIComponent(chargeId)}`);
          if (charge["id"] !== chargeId) throw new Error("stripe_growth_invalid");
        }
        const customer = charge["customer"];
        const organization = identifier(customer, "cus")
          ? await input.resolveCustomer(customer)
          : null;
        const payment = charge["payment_intent"];
        facts.push({
          schema_version: 1 as const,
          fact_type: "payment" as const,
          fact_id: transactionId,
          source_id: transactionId,
          occurred_at: occurred,
          observed_at: new Date().toISOString(),
          source_version: transactionId,
          account_id: null,
          organization_id: organization,
          project_id: null,
          operation_id: null,
          provider_fact_id: transactionId,
          payment_id: identifier(payment, "pi") ? payment : null,
          amount_minor: Math.abs(amount as number),
          currency: transaction["currency"].toUpperCase(),
          money_effect: effect,
        });
      }
      if (result["has_more"] && !last) throw new Error("stripe_growth_invalid");
      return {
        facts,
        next_cursor: result["has_more"] ? last : null,
        source_watermark: watermark,
        history_floor: null,
      };
    },
    async readGrowthOpenDisputePage(page: { cursor: string | null; limit: number }) {
      if (
        !page ||
        !Number.isInteger(page.limit) ||
        page.limit < 1 ||
        page.limit > 200 ||
        (page.cursor !== null && !identifier(page.cursor, "du")) ||
        !identifier(input.accountId, "acct") ||
        !input.credential.startsWith(input.mode === "test" ? "sk_test_" : "sk_live_")
      )
        throw new TypeError("invalid growth dispute page");
      const account = await get("account");
      if (account["id"] !== input.accountId) throw new Error("stripe_growth_scope_conflict");
      const params = new URLSearchParams({ limit: String(Math.min(page.limit, 100)) });
      if (page.cursor) params.set("starting_after", page.cursor);
      const result = await get("disputes", params);
      if (
        !Array.isArray(result["data"]) ||
        result["data"].length > Math.min(page.limit, 100) ||
        typeof result["has_more"] !== "boolean"
      )
        throw new Error("stripe_growth_invalid");
      const facts = [];
      let last: string | null = null;
      let watermark: string | null = null;
      for (const raw of result["data"]) {
        const dispute = object(raw);
        const disputeId = dispute["id"];
        if (!identifier(disputeId, "du")) throw new Error("stripe_growth_invalid");
        last = disputeId;
        if (typeof dispute["created"] !== "number" || !Number.isSafeInteger(dispute["created"]))
          throw new Error("stripe_growth_invalid");
        const occurred = new Date(dispute["created"] * 1000).toISOString();
        watermark ??= occurred;
        if (
          ![
            "warning_needs_response",
            "warning_under_review",
            "needs_response",
            "under_review",
          ].includes(String(dispute["status"]))
        )
          continue;
        const amount = dispute["amount"];
        const currency = dispute["currency"];
        const chargeId = dispute["charge"];
        if (
          !Number.isSafeInteger(amount) ||
          (amount as number) < 0 ||
          typeof currency !== "string" ||
          !/^[a-z]{3}$/u.test(currency) ||
          (!identifier(chargeId, "ch") && !identifier(chargeId, "py"))
        )
          throw new Error("stripe_growth_invalid");
        const charge = await get(`charges/${encodeURIComponent(chargeId)}`);
        if (charge["id"] !== chargeId) throw new Error("stripe_growth_invalid");
        const customer = charge["customer"];
        const payment = charge["payment_intent"];
        const organization = identifier(customer, "cus")
          ? await input.resolveCustomer(customer)
          : null;
        facts.push({
          schema_version: 1 as const,
          fact_type: "payment" as const,
          fact_id: disputeId,
          source_id: disputeId,
          occurred_at: occurred,
          observed_at: new Date().toISOString(),
          source_version: disputeId,
          account_id: null,
          organization_id: organization,
          project_id: null,
          operation_id: null,
          provider_fact_id: disputeId,
          payment_id: identifier(payment, "pi") ? payment : null,
          amount_minor: amount as number,
          currency: currency.toUpperCase(),
          money_effect: "none" as const,
        });
      }
      if (result["has_more"] && !last) throw new Error("stripe_growth_invalid");
      return {
        facts,
        next_cursor: result["has_more"] ? last : null,
        source_watermark: watermark,
        history_floor: null,
      };
    },
  };
}
