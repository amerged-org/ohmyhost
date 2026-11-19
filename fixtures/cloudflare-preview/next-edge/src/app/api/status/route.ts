export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    requestNonce: crypto.randomUUID(),
    secretConfigured: typeof process.env.NEXT_TEST_SECRET === "string",
  });
}
