import { defineMiddleware } from "astro:middleware";
export const onRequest = defineMiddleware(async (_, next) => {
  const response = await next();
  response.headers.set("x-astro-middleware", "verified");
  return response;
});
