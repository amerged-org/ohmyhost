import type { APIRoute } from "astro";
export const GET: APIRoute = ({ url, request }) =>
  Response.json({
    name: url.searchParams.get("name"),
    header: request.headers.get("x-astro-test"),
    renderedAt: new Date().toISOString(),
  });
