export const dynamic = "force-dynamic";

export default function Home() {
  const requestNonce = crypto.randomUUID();
  const secretConfigured = typeof process.env.NEXT_TEST_SECRET === "string";
  return (
    <main>
      <h1>Next.js edge SSR on ohmyhost</h1>
      <p data-request-nonce={requestNonce}>{requestNonce}</p>
      <p data-secret-configured={String(secretConfigured)}>
        {secretConfigured ? "runtime secret configured" : "runtime secret absent"}
      </p>
    </main>
  );
}
