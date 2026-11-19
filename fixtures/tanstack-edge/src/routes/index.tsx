import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

const readRequestState = createServerFn({ method: "GET" }).handler(() => {
  const bindings = env as unknown as Record<string, string | undefined>;
  return {
    requestNonce: crypto.randomUUID(),
    secretConfigured: typeof bindings["EDGE_TEST_SECRET"] === "string",
  };
});

export const Route = createFileRoute("/")({
  loader: () => readRequestState(),
  component: Home,
});

function Home() {
  const state = Route.useLoaderData();
  return (
    <main>
      <h1>TanStack Start edge SSR on ohmyhost</h1>
      <p data-request-nonce={state.requestNonce}>{state.requestNonce}</p>
      <p data-secret-configured={String(state.secretConfigured)}>
        {state.secretConfigured ? "runtime secret configured" : "runtime secret absent"}
      </p>
    </main>
  );
}
