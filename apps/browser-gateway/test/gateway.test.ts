import { afterEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { createBrowserGateway, type BrowserBinding } from "../src/gateway.js";
import type { BrowserGatewayRuntime } from "@ohmyhost/platform";

const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const scope = {
  organizationId: projectId,
  projectId,
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  keySha256: "a".repeat(64),
  keyRevision: 1,
  deploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  revisionId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  ownershipVersion: 1,
  billingEpochId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
};
const billScope = {
  organizationId: scope.organizationId,
  projectId: scope.projectId,
  environmentId: scope.environmentId,
};
const key = `omh_browser_${projectId}_${"a".repeat(43)}`;
const reservationId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
async function pdf(pages: number): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  for (let index = 0; index < pages; index++) document.addPage();
  return document.save();
}
function request(html: string, authorization = `Bearer ${key}`): Request {
  return new Request("https://browser.ohmyho.st/v1/pdf", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ html }),
  });
}
function fixture(response: Response) {
  const runtime: BrowserGatewayRuntime = {
    authorizeKey: vi.fn(async () => scope),
    admit: vi.fn(async () => ({ admitted: true as const, reservedMicros: 150_000 })),
    settle: vi.fn(async () => ({ settled: true as const, chargedMicros: 500 })),
    release: vi.fn(async () => ({ released: true })),
    sweep: vi.fn(async () => ({ released: 0 })),
  };
  const browser = {
    quickAction: vi.fn<BrowserBinding["quickAction"]>(async () => response),
  };
  const limiter = { limit: vi.fn(async () => ({ success: true })) };
  const journal = { record: vi.fn(async () => undefined) };
  return {
    runtime,
    browser,
    journal,
    gateway: createBrowserGateway({
      runtime,
      browser,
      journal,
      limiter,
      authLimiter: limiter,
      newReservationId: () => reservationId,
    }),
  };
}

afterEach(() => vi.useRealTimers());
describe("Browser gateway", () => {
  it("refuses oversized or aborted input even when cancelling the input stream fails", async () => {
    const f = fixture(new Response());
    const diagnostics = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cancelOversized = vi.fn(async () => {
      throw new Error("private stream failure");
    });
    const oversized = new Request("https://browser.ohmyho.st/v1/pdf", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(6 * 1024 * 1024 + 65));
        },
        cancel: cancelOversized,
      }),
      duplex: "half",
    } as RequestInit);
    try {
      const refused = await f.gateway.fetch(oversized);
      expect(refused.status).toBe(413);
      expect(await refused.json()).toEqual({ error: { code: "body_too_large" } });
      expect(cancelOversized).toHaveBeenCalledOnce();

      const cancelAborted = vi.fn(async () => {
        throw new Error("private abort failure");
      });
      const controller = new AbortController();
      const aborted = new Request("https://browser.ohmyho.st/v1/pdf", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: new ReadableStream<Uint8Array>({ cancel: cancelAborted }),
        signal: controller.signal,
        duplex: "half",
      } as RequestInit);
      const tasks: Promise<unknown>[] = [];
      const result = f.gateway.fetch(aborted, {
        waitUntil(task) {
          tasks.push(task);
        },
      });
      while (!aborted.body?.locked) await new Promise<void>((resolve) => setImmediate(resolve));
      controller.abort();
      expect((await result).status).toBe(499);
      await Promise.all(tasks);
      expect(cancelAborted).toHaveBeenCalledOnce();
      expect(f.runtime.admit).not.toHaveBeenCalled();
      expect(f.browser.quickAction).not.toHaveBeenCalled();
      expect(f.journal.record).not.toHaveBeenCalled();
      expect(diagnostics).not.toHaveBeenCalled();
    } finally {
      diagnostics.mockRestore();
    }
  });

  it("keeps measured billing and fixed errors when discarding provider response bodies fails", async () => {
    const makeBody = () => {
      const cancel = vi.fn(async () => {
        throw new Error("private provider response");
      });
      return { cancel, stream: new ReadableStream<Uint8Array>({ cancel }) };
    };
    const providerBody = makeBody();
    const rejected = fixture(
      new Response(providerBody.stream, {
        status: 503,
        headers: { "x-browser-ms-used": "7.5" },
      }),
    );
    const failed = await rejected.gateway.fetch(request("private-document"));
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: { code: "browser_provider_failed" } });
    expect(providerBody.cancel).toHaveBeenCalledOnce();
    expect(rejected.runtime.settle).toHaveBeenCalledOnce();
    expect(rejected.runtime.settle).toHaveBeenCalledWith({
      scope: billScope,
      reservationId,
      browserMs: "7.5",
    });
    expect(rejected.journal.record).toHaveBeenCalledWith({
      scope: billScope,
      reservationId,
      browserMs: "7.5",
    });

    const unsettledBody = makeBody();
    const unsettled = fixture(
      new Response(unsettledBody.stream, {
        headers: { "x-browser-ms-used": "42" },
      }),
    );
    vi.mocked(unsettled.runtime.settle).mockRejectedValue(new Error("private accounting failure"));
    const unavailable = await unsettled.gateway.fetch(request("private-document"));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: { code: "browser_unavailable" } });
    expect(unsettledBody.cancel).toHaveBeenCalledOnce();
    expect(unsettled.runtime.settle).toHaveBeenCalledTimes(2);
    expect(unsettled.runtime.settle).toHaveBeenCalledWith({
      scope: billScope,
      reservationId,
      browserMs: "42",
    });
    expect(unsettled.journal.record).toHaveBeenCalledOnce();
    expect(unsettled.journal.record).toHaveBeenCalledWith({
      scope: billScope,
      reservationId,
      browserMs: "42",
    });
    expect(JSON.stringify(unsettled.journal.record.mock.calls)).not.toContain("private-document");
    expect(JSON.stringify(unsettled.journal.record.mock.calls)).not.toContain(key);
  });

  it.each([
    "<link rel='preconnect' href='https://observer.example'>",
    "< BASE href='https://observer.example/'>",
    "<IFRAME src='data:text/html,example'></IFRAME>",
    "<frame / >",
    "<ObJeCt data='data:text/html,example'>",
    "<embed\t src='https://observer.example'>",
    "</ PoRtAl>",
    "<fencedframe/> that must not be forwarded",
  ])("rejects resource hints and nested browsing contexts before Browser Run: %s", async (html) => {
    const f = fixture(new Response(Uint8Array.from(await pdf(1)).buffer));
    const response = await f.gateway.fetch(request(html));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "unsupported_html_tag" } });
    expect(f.runtime.admit).not.toHaveBeenCalled();
    expect(f.browser.quickAction).not.toHaveBeenCalled();
  });

  it("accepts inline SVG and data assets together with ordinary anchor URLs and HTTPS text", async () => {
    const f = fixture(new Response(Uint8Array.from(await pdf(1)).buffer));
    const html = `<style>@font-face{font-family:embedded;src:url(data:font/woff2;base64,AA==)}</style>
      <svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>
      <img src="data:image/png;base64,AA=="><a href="https://example.com/invoice">Invoice</a>
      <p>Read https://example.com/terms</p>`;
    expect((await f.gateway.fetch(request(html))).status).toBe(200);
    expect(f.browser.quickAction).toHaveBeenCalledWith("pdf", expect.objectContaining({ html }));
    const longText = `<${" ".repeat(1024 * 1024 - 2)}X`;
    const large = fixture(new Response(Uint8Array.from(await pdf(1)).buffer));
    const started = performance.now();
    expect((await large.gateway.fetch(request(longText))).status).toBe(200);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(large.browser.quickAction).toHaveBeenCalledOnce();
  });

  it("uses the actual PDF action with fixed network, JavaScript, timeout and cache policy, settles measured duration and returns the complete PDF", async () => {
    const bytes = await pdf(2);
    const f = fixture(
      new Response(Uint8Array.from(bytes).buffer, {
        headers: { "content-type": "application/pdf", "x-browser-ms-used": "123" },
      }),
    );
    const response = await f.gateway.fetch(request("<h1>hello</h1>"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(f.browser.quickAction).toHaveBeenCalledWith(
      "pdf",
      expect.objectContaining({
        html: "<h1>hello</h1>",
        cacheTTL: 0,
        setJavaScriptEnabled: false,
        allowRequestPattern: ["^data:"],
        actionTimeout: expect.any(Number),
        gotoOptions: { timeout: expect.any(Number) },
        pdfOptions: {
          timeout: expect.any(Number),
          printBackground: true,
          preferCSSPageSize: true,
        },
      }),
    );
    expect(f.runtime.settle).toHaveBeenCalledWith({
      scope: billScope,
      reservationId,
      browserMs: "123",
    });
    expect(f.journal.record).toHaveBeenCalledWith({
      scope: billScope,
      reservationId,
      browserMs: "123",
    });
    const fractional = fixture(
      new Response(Uint8Array.from(bytes).buffer, {
        headers: { "x-browser-ms-used": "1393.57373046875" },
      }),
    );
    expect((await fractional.gateway.fetch(request("x"))).status).toBe(200);
    expect(fractional.runtime.settle).toHaveBeenCalledWith({
      scope: billScope,
      reservationId,
      browserMs: "1393.57373046875",
    });
    const exponent = fixture(
      new Response(Uint8Array.from(bytes).buffer, { headers: { "x-browser-ms-used": "1.234e2" } }),
    );
    expect((await exponent.gateway.fetch(request("x"))).status).toBe(200);
    expect(exponent.runtime.settle).toHaveBeenCalledWith({
      scope: billScope,
      reservationId,
      browserMs: "123.4",
    });
    const options = f.browser.quickAction.mock.calls[0]?.[1];
    expect(options?.actionTimeout).toBeGreaterThan(0);
    expect(options?.actionTimeout).toBeLessThanOrEqual(15_000);
    expect(options?.gotoOptions.timeout).toBe(options?.actionTimeout);
    expect(options?.pdfOptions.timeout).toBe(options?.actionTimeout);
  });
  it("rejects bad authentication, invalid input, oversized HTML, and denied admissions before the provider", async () => {
    const f = fixture(new Response(Uint8Array.from(await pdf(1)).buffer));
    expect((await f.gateway.fetch(request("x", "Bearer invalid"))).status).toBe(401);
    expect(
      (
        await f.gateway.fetch(
          new Request("https://browser.ohmyho.st/v1/pdf", {
            method: "POST",
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            body: JSON.stringify({ html: "x", url: "https://example.com" }),
          }),
        )
      ).status,
    ).toBe(400);
    expect((await f.gateway.fetch(request("x".repeat(1024 * 1024 + 1)))).status).toBe(413);
    vi.mocked(f.runtime.admit).mockResolvedValueOnce({
      admitted: false,
      denial: "project_budget_exceeded",
    });
    expect((await f.gateway.fetch(request("x"))).status).toBe(402);
    expect(f.browser.quickAction).not.toHaveBeenCalled();
    const bytes = await pdf(1);
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const limited = fixture(new Response(Uint8Array.from(bytes).buffer));
    limited.browser.quickAction.mockImplementation(async () => {
      await gate;
      return new Response(Uint8Array.from(bytes).buffer);
    });
    const first = limited.gateway.fetch(request("first"));
    const second = limited.gateway.fetch(request("second"));
    await vi.waitFor(() => expect(limited.browser.quickAction).toHaveBeenCalledTimes(2));
    expect((await limited.gateway.fetch(request("third"))).status).toBe(503);
    vi.mocked(limited.runtime.authorizeKey).mockResolvedValueOnce({
      ...scope,
      organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
    });
    const other = limited.gateway.fetch(request("another tenant"));
    await vi.waitFor(() => expect(limited.browser.quickAction).toHaveBeenCalledTimes(3));
    unblock();
    expect((await Promise.all([first, second, other])).map((response) => response.status)).toEqual([
      200, 200, 200,
    ]);

    let finishAuthorization!: (value: typeof scope) => void;
    let authorizationStarted!: () => void;
    const authorizationPending = new Promise<typeof scope>((resolve) => {
      finishAuthorization = resolve;
    });
    const authorizationStart = new Promise<void>((resolve) => {
      authorizationStarted = resolve;
    });
    const abortedAuth = fixture(new Response());
    vi.mocked(abortedAuth.runtime.authorizeKey).mockImplementationOnce(() => {
      authorizationStarted();
      return authorizationPending;
    });
    const authController = new AbortController(),
      authTasks: Promise<unknown>[] = [];
    const authResponse = abortedAuth.gateway.fetch(
      new Request(request("x"), { signal: authController.signal }),
      { waitUntil: (promise) => authTasks.push(promise) },
    );
    await authorizationStart;
    authController.abort();
    expect((await authResponse).status).toBe(499);
    finishAuthorization(scope);
    await Promise.all(authTasks);
    expect(abortedAuth.runtime.admit).not.toHaveBeenCalled();
    expect(abortedAuth.browser.quickAction).not.toHaveBeenCalled();

    let finishAdmission!: (value: { admitted: true; reservedMicros: number }) => void;
    let admissionStarted!: () => void;
    const admissionPending = new Promise<{ admitted: true; reservedMicros: number }>((resolve) => {
      finishAdmission = resolve;
    });
    const admissionStart = new Promise<void>((resolve) => {
      admissionStarted = resolve;
    });
    const abortedAdmission = fixture(new Response());
    vi.mocked(abortedAdmission.runtime.admit).mockImplementationOnce(() => {
      admissionStarted();
      return admissionPending;
    });
    const admitController = new AbortController(),
      admitTasks: Promise<unknown>[] = [];
    const admitResponse = abortedAdmission.gateway.fetch(
      new Request(request("x"), { signal: admitController.signal }),
      { waitUntil: (promise) => admitTasks.push(promise) },
    );
    await admissionStart;
    admitController.abort();
    expect((await admitResponse).status).toBe(499);
    finishAdmission({ admitted: true, reservedMicros: 150_000 });
    await Promise.all(admitTasks);
    expect(abortedAdmission.runtime.release).toHaveBeenCalledWith({
      scope: billScope,
      reservationId,
      reason: "client_aborted",
    });
    expect(abortedAdmission.browser.quickAction).not.toHaveBeenCalled();

    let finishTimedAuthorization!: (value: typeof scope) => void;
    let timedAuthorizationStarted!: () => void;
    const timedAuthorizationPending = new Promise<typeof scope>((resolve) => {
      finishTimedAuthorization = resolve;
    });
    const timedAuthorizationStart = new Promise<void>((resolve) => {
      timedAuthorizationStarted = resolve;
    });
    const timedAuth = fixture(new Response());
    vi.mocked(timedAuth.runtime.authorizeKey).mockImplementationOnce(() => {
      timedAuthorizationStarted();
      return timedAuthorizationPending;
    });
    const timeoutTasks: Promise<unknown>[] = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timedResponse = timedAuth.gateway.fetch(request("x"), {
      waitUntil: (promise) => timeoutTasks.push(promise),
    });
    await timedAuthorizationStart;
    await vi.advanceTimersByTimeAsync(30_001);
    expect((await timedResponse).status).toBe(504);
    vi.useRealTimers();
    finishTimedAuthorization(scope);
    await Promise.all(timeoutTasks);
    expect(timedAuth.runtime.admit).not.toHaveBeenCalled();
    expect(timedAuth.browser.quickAction).not.toHaveBeenCalled();

    const lostAdmission = fixture(new Response());
    vi.mocked(lostAdmission.runtime.admit).mockRejectedValueOnce(new Error("lost response"));
    expect((await lostAdmission.gateway.fetch(request("x"))).status).toBe(503);
    expect(lostAdmission.runtime.release).toHaveBeenCalledWith({
      scope: billScope,
      reservationId,
      reason: "client_aborted",
    });
    expect(lostAdmission.browser.quickAction).not.toHaveBeenCalled();

    // A cancelled waitUntil must not leave a stale capacity counter in a surviving isolate.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const stale = fixture(new Response());
    let unblockStale!: () => void, firstTwoStarted!: () => void, thirdStarted!: () => void;
    const gateStale = new Promise<void>((resolve) => {
      unblockStale = resolve;
    });
    const firstTwo = new Promise<void>((resolve) => {
      firstTwoStarted = resolve;
    });
    const thirdStart = new Promise<void>((resolve) => {
      thirdStarted = resolve;
    });
    let startedCount = 0;
    stale.browser.quickAction.mockImplementation(async () => {
      startedCount++;
      if (startedCount === 2) firstTwoStarted();
      if (startedCount === 3) thirdStarted();
      await gateStale;
      return new Response(Uint8Array.from(bytes).buffer);
    });
    const staleTasks: Promise<unknown>[] = [];
    const staleContext = {
      waitUntil: (promise: Promise<unknown>) => {
        staleTasks.push(promise);
      },
    };
    const staleFirst = stale.gateway.fetch(request("first"), staleContext),
      staleSecond = stale.gateway.fetch(request("second"), staleContext);
    await firstTwo;
    await vi.advanceTimersByTimeAsync(65_001);
    expect((await staleFirst).status).toBe(504);
    expect((await staleSecond).status).toBe(504);
    const replacement = stale.gateway.fetch(request("replacement"), staleContext);
    await thirdStart;
    unblockStale();
    vi.useRealTimers();
    expect((await replacement).status).toBe(200);
    await Promise.all(staleTasks);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const cancel = vi.fn();
    const stalled = new ReadableStream<Uint8Array>({ cancel });
    const stalledRequest = new Request("https://browser.ohmyho.st/v1/pdf", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: stalled,
      duplex: "half",
    } as RequestInit);
    const stalledResult = f.gateway.fetch(stalledRequest);
    while (!stalledRequest.body?.locked)
      await new Promise<void>((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(30_001);
    expect((await stalledResult).status).toBe(504);
    expect(cancel).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
  it("rejects invalid or oversized PDFs and more than 50 pages; measured failures settle, absent measurement is never estimated", async () => {
    for (const [body, status] of [
      [await pdf(51), 422],
      [new TextEncoder().encode("not a pdf"), 502],
      [new Uint8Array(10 * 1024 * 1024 + 1), 502],
    ] as const) {
      const f = fixture(
        new Response(Uint8Array.from(body).buffer, { headers: { "x-browser-ms-used": "7" } }),
      );
      expect((await f.gateway.fetch(request("x"))).status).toBe(status);
      expect(f.runtime.settle).toHaveBeenCalledWith({
        scope: billScope,
        reservationId,
        browserMs: "7",
      });
    }
    const largeNumberPdf = await PDFDocument.create();
    largeNumberPdf.addPage([10_000_000_000_000_000, 800]);
    const quiet = fixture(
      new Response(Uint8Array.from(await largeNumberPdf.save()).buffer, {
        headers: { "x-browser-ms-used": "1" },
      }),
    );
    const warn = vi.spyOn(console, "warn");
    await quiet.gateway.fetch(request("x"));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    const f = fixture(new Response("provider rejected", { status: 503 }));
    expect((await f.gateway.fetch(request("x"))).status).toBe(502);
    expect(f.runtime.settle).toHaveBeenCalledWith({
      scope: billScope,
      reservationId,
      browserMs: null,
    });
    const threw = fixture(new Response());
    threw.browser.quickAction.mockRejectedValueOnce(new Error("private provider message"));
    expect((await threw.gateway.fetch(request("x"))).status).toBe(502);
    expect(threw.runtime.settle).toHaveBeenCalledWith({
      scope: billScope,
      reservationId,
      browserMs: null,
    });
    const unsettled = fixture(
      new Response(Uint8Array.from(await pdf(1)).buffer, {
        headers: { "x-browser-ms-used": "42" },
      }),
    );
    vi.mocked(unsettled.runtime.settle).mockRejectedValue(new Error("private internal error"));
    expect((await unsettled.gateway.fetch(request("x"))).status).toBe(503);
    expect(unsettled.runtime.settle).toHaveBeenCalledTimes(2);
    expect(unsettled.journal.record).toHaveBeenCalledWith({
      scope: billScope,
      reservationId,
      browserMs: "42",
    });
    const stuckJournal = fixture(
      new Response(Uint8Array.from(await pdf(1)).buffer, {
        headers: { "x-browser-ms-used": "12.5" },
      }),
    );
    let journalStarted!: () => void;
    const journalStart = new Promise<void>((resolve) => {
      journalStarted = resolve;
    });
    stuckJournal.journal.record.mockImplementation(() => {
      journalStarted();
      return new Promise(() => undefined);
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const recovered = stuckJournal.gateway.fetch(request("x"));
    await journalStart;
    await vi.advanceTimersByTimeAsync(5_001);
    expect((await recovered).status).toBe(200);
    expect(stuckJournal.runtime.settle).toHaveBeenCalledWith({
      scope: billScope,
      reservationId,
      browserMs: "12.5",
    });
    vi.useRealTimers();
    const nearDeadline = fixture(new Response());
    let resolveNearProvider!: (response: Response) => void, nearStarted!: () => void;
    const nearStart = new Promise<void>((resolve) => {
      nearStarted = resolve;
    });
    const nearProvider = new Promise<Response>((resolve) => {
      resolveNearProvider = resolve;
    });
    nearDeadline.browser.quickAction.mockImplementation(() => {
      nearStarted();
      return nearProvider;
    });
    nearDeadline.journal.record.mockImplementation(() => new Promise(() => undefined));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const nearResult = nearDeadline.gateway.fetch(request("x"));
    await nearStart;
    await vi.advanceTimersByTimeAsync(26_000);
    resolveNearProvider(
      new Response(Uint8Array.from(await pdf(1)).buffer, {
        headers: { "x-browser-ms-used": "12.5" },
      }),
    );
    expect((await nearResult).status).toBe(200);
    expect(nearDeadline.runtime.settle).toHaveBeenCalledOnce();
    vi.useRealTimers();

    const stuckCore = fixture(
      new Response(Uint8Array.from(await pdf(1)).buffer, {
        headers: { "x-browser-ms-used": "12.5" },
      }),
    );
    let coreStarted!: () => void;
    const coreStart = new Promise<void>((resolve) => {
      coreStarted = resolve;
    });
    vi.mocked(stuckCore.runtime.settle).mockImplementation(() => {
      coreStarted();
      return new Promise(() => undefined);
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pendingCore = stuckCore.gateway.fetch(request("x"));
    await coreStart;
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await pendingCore).status).toBe(503);
    expect(stuckCore.runtime.settle).toHaveBeenCalledTimes(2);
    expect(stuckCore.journal.record).toHaveBeenCalledWith({
      scope: billScope,
      reservationId,
      browserMs: "12.5",
    });
    vi.useRealTimers();
    const bothDown = fixture(
      new Response(Uint8Array.from(await pdf(1)).buffer, {
        headers: { "x-browser-ms-used": "12.5" },
      }),
    );
    bothDown.journal.record.mockRejectedValue(new Error("private journal error"));
    vi.mocked(bothDown.runtime.settle).mockRejectedValue(new Error("private core error"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await bothDown.gateway.fetch(request("PRIVATE-HTML"))).status).toBe(503);
    expect(warning).toHaveBeenCalledWith(
      JSON.stringify({
        event: "browser_measurement_unconfirmed",
        reservationId,
        browserMs: "12.5",
      }),
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain("PRIVATE-HTML");
    expect(JSON.stringify(warning.mock.calls)).not.toContain(key);
    warning.mockRestore();

    const slowBytes = await pdf(1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let complete!: (response: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const pending = new Promise<Response>((resolve) => {
      complete = resolve;
    });
    const slow = fixture(new Response());
    slow.browser.quickAction.mockImplementation(() => {
      markStarted();
      return pending;
    });
    const keepAlive: Promise<unknown>[] = [];
    const response = slow.gateway.fetch(request("x"), {
      waitUntil: (promise) => keepAlive.push(promise),
    });
    await started;
    await vi.advanceTimersByTimeAsync(30_001);
    expect((await response).status).toBe(504);
    vi.useRealTimers();
    complete(
      new Response(Uint8Array.from(slowBytes).buffer, {
        headers: { "x-browser-ms-used": "30123" },
      }),
    );
    await Promise.all(keepAlive);
    expect(slow.runtime.settle).toHaveBeenCalledWith({
      scope: billScope,
      reservationId,
      browserMs: "30123",
    });
    let finishProvider!: (response: Response) => void;
    let providerStarted!: () => void;
    const providerStart = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const providerPending = new Promise<Response>((resolve) => {
      finishProvider = resolve;
    });
    const dispatched = fixture(new Response());
    dispatched.browser.quickAction.mockImplementation(() => {
      providerStarted();
      return providerPending;
    });
    const controller = new AbortController(),
      tasks: Promise<unknown>[] = [];
    const aborted = dispatched.gateway.fetch(
      new Request(request("x"), { signal: controller.signal }),
      { waitUntil: (promise) => tasks.push(promise) },
    );
    await providerStart;
    controller.abort();
    expect((await aborted).status).toBe(499);
    finishProvider(
      new Response(Uint8Array.from(slowBytes).buffer, { headers: { "x-browser-ms-used": "55" } }),
    );
    await Promise.all(tasks);
    expect(dispatched.runtime.settle).toHaveBeenCalledTimes(1);
    expect(dispatched.runtime.settle).toHaveBeenCalledWith({
      scope: billScope,
      reservationId,
      browserMs: "55",
    });
    expect(dispatched.runtime.release).not.toHaveBeenCalled();
  });
});
