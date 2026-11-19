import { env } from "cloudflare:workers";
import handler from "../../notes-handler";
export const prerender = false;
export const ALL = ({ request }: { request: Request }) => handler.fetch(request, env as never);
