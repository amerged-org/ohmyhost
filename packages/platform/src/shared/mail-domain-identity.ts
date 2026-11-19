import { parse } from "tldts";

/** PSL classification includes private suffixes: unrelated hosted tenants never share mail. */
export function classifyMailDomain(input: string): {
  hostname: string;
  registrableDomain: string;
} {
  if (
    input.length > 253 ||
    input.length === 0 ||
    /[\s/:@?#\\]/u.test(input) ||
    [...input].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new TypeError("Invalid mail domain identity");
  const hostname = new URL(`https://${input}`).hostname.toLowerCase().replace(/\.$/u, "");
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
      hostname,
    )
  )
    throw new TypeError("Invalid mail domain identity");
  const result = parse(hostname, { allowPrivateDomains: true });
  if (result.isIp || !result.domain || (!result.isIcann && !result.isPrivate))
    throw new TypeError("Mail domain requires a registrable public domain");
  return { hostname, registrableDomain: result.domain };
}

/** Platform-owned hostnames cannot be customer sender or application identities. */
export function classifyCustomerMailDomain(input: string) {
  const result = classifyMailDomain(input);
  const hostname = result.hostname;
  if (
    hostname === "ohmyho.st" ||
    hostname.endsWith(".ohmyho.st") ||
    hostname === "omh.st" ||
    hostname.endsWith(".omh.st") ||
    hostname.endsWith(".poc.aixyte.com")
  )
    throw new TypeError("A customer mail domain is required");
  return result;
}

/** Platform names are infrastructure identities, never customer application proof. */
export function classifyApplicationMailIdentity(input: string) {
  return classifyCustomerMailDomain(input);
}

export function validateMailSenderSettings(input: {
  domain: string;
  senderAddresses: readonly string[];
  defaultFrom: string;
  defaultReplyTo: string | null;
}) {
  const domain = classifyMailDomain(input.domain).hostname;
  const addresses = [...new Set(input.senderAddresses.map((value) => validateMailMailbox(value)))];
  if (
    addresses.length === 0 ||
    addresses.length > 32 ||
    addresses.some((value) => value.split("@")[1] !== domain)
  )
    throw new TypeError("Sender addresses must use the exact verified mail domain");
  const defaultFrom = validateMailMailbox(input.defaultFrom);
  if (addresses.some((value) => !/^[A-Za-z0-9._%+-]{1,64}@/u.test(value)))
    throw new TypeError("Invalid sender local part");
  if (!addresses.includes(defaultFrom)) throw new TypeError("Default sender must be allowed");
  return {
    senderAddresses: addresses.sort(),
    defaultFrom,
    defaultReplyTo:
      input.defaultReplyTo === null ? null : validateMailMailbox(input.defaultReplyTo),
  };
}

export function validateMailMailbox(value: string): string {
  if (value.length > 320 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9.-]+$/u.test(value))
    throw new TypeError("Invalid mail address");
  const at = value.lastIndexOf("@");
  return `${value.slice(0, at)}@${classifyMailDomain(value.slice(at + 1)).hostname}`;
}
