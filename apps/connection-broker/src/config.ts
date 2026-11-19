export interface BrokerSecrets {
  clientId?: string;
  clientSecret?: string;
  vaultKey?: string;
}
export function configurationState(
  secrets: BrokerSecrets,
): "provider_unconfigured" | "provider_misconfigured" | "configured" {
  const { clientId: id, clientSecret: secret, vaultKey: key } = secrets;
  if (id === undefined || secret === undefined || key === undefined) return "provider_unconfigured";
  if (!id.trim() || !secret.trim() || id.length > 1024 || secret.length > 4096)
    return "provider_misconfigured";
  try {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(key) || atob(key).length !== 32)
      return "provider_misconfigured";
  } catch {
    return "provider_misconfigured";
  }
  return "configured";
}
