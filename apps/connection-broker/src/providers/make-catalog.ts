const zones: Readonly<Record<string, string>> = Object.freeze({
  eu1: "https://eu1.make.com",
  eu2: "https://eu2.make.com",
  we: "https://we.make.com",
  us1: "https://us1.make.com",
  us2: "https://us2.make.com",
  "eu1-celonis": "https://eu1.make.celonis.com",
  "us1-celonis": "https://us1.make.celonis.com",
});
export function makeZoneOrigin(zone: string): string {
  if (!Object.hasOwn(zones, zone)) throw new Error("invalid_make_zone");
  return zones[zone] ?? "";
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export async function readBounded(
  response: Response,
  maxBytes = 4 * 1024 * 1024,
): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error("make_discovery_failed");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error("make_discovery_too_large");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of chunks) {
    bytes.set(part, offset);
    offset += part.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("make_discovery_invalid");
  }
}
/** Intersect Make's authenticated, team-scoped result with our pinned definitions. */
export interface MakeOrganization {
  id: number;
  name: string;
  zone: string;
}
export interface MakeTeam {
  id: number;
  name: string;
  organizationId: number;
}
async function getDiscovery(
  path: string,
  request: { zone: string; accessToken: string },
  fetcher: typeof fetch,
): Promise<Record<string, unknown>> {
  if (!request.accessToken) throw new Error("make_discovery_invalid");
  const response = await fetcher(`${makeZoneOrigin(request.zone)}/api/v2${path}`, {
    headers: { authorization: `Bearer ${request.accessToken}`, accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
  });
  const body = await readBounded(response);
  if (!isRecord(body)) throw new Error("make_discovery_invalid");
  return body;
}
const validId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const validName = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1024;
/** Make SDK organizations.list: organizations accessible to this OAuth identity in the selected zone. */
export async function listMakeOrganizations(
  request: { zone: string; accessToken: string },
  fetcher: typeof fetch = fetch,
): Promise<MakeOrganization[]> {
  const body = await getDiscovery(
    "/organizations?cols%5B%5D=id&cols%5B%5D=name&cols%5B%5D=zone",
    request,
    fetcher,
  );
  if (!Array.isArray(body["organizations"])) throw new Error("make_discovery_invalid");
  return body["organizations"].map((row: unknown) => {
    if (!isRecord(row) || !validId(row["id"]) || !validName(row["name"]) || !validName(row["zone"]))
      throw new Error("make_discovery_invalid");
    const zone = ["eu1", "eu2", "we", "us1", "us2", "eu1-celonis", "us1-celonis"].find(
      (candidate) =>
        new URL(makeZoneOrigin(candidate)).hostname === row["zone"] || candidate === row["zone"],
    );
    if (!zone) throw new Error("make_discovery_invalid");
    return { id: row["id"], name: row["name"], zone };
  });
}
/** Make SDK teams.list; first recheck that the same token can access the selected organization. */
export async function listMakeTeams(
  request: { zone: string; accessToken: string; organizationId: number },
  fetcher: typeof fetch = fetch,
): Promise<MakeTeam[]> {
  if (
    !validId(request.organizationId) ||
    !(await listMakeOrganizations(request, fetcher)).some(
      (org) => org.id === request.organizationId && org.zone === request.zone,
    )
  )
    throw new Error("make_organization_unavailable");
  const body = await getDiscovery(
    `/teams?organizationId=${request.organizationId}`,
    request,
    fetcher,
  );
  if (!Array.isArray(body["teams"])) throw new Error("make_discovery_invalid");
  return body["teams"].map((row: unknown) => {
    if (
      !isRecord(row) ||
      !validId(row["id"]) ||
      !validName(row["name"]) ||
      row["organizationId"] !== request.organizationId
    )
      throw new Error("make_discovery_invalid");
    return { id: row["id"], name: row["name"], organizationId: request.organizationId };
  });
}

/** Make connections.list, exposing only the selected team's non-secret metadata. */
export async function listMakeConnections(
  request: { zone: string; accessToken: string; teamId: number },
  fetcher: typeof fetch = fetch,
): Promise<{ id: number; name: string }[]> {
  if (!validId(request.teamId)) throw new Error("make_team_unavailable");
  const body = await getDiscovery(
    `/connections?teamId=${request.teamId}&cols%5B%5D=id&cols%5B%5D=name`,
    request,
    fetcher,
  );
  if (!Array.isArray(body["connections"])) throw new Error("make_discovery_invalid");
  return body["connections"].map((row: unknown) => {
    if (
      !isRecord(row) ||
      !validId(row["id"]) ||
      !validName(row["name"]) ||
      (row["teamId"] !== undefined && row["teamId"] !== request.teamId)
    )
      throw new Error("make_discovery_invalid");
    return { id: row["id"], name: row["name"] };
  });
}
