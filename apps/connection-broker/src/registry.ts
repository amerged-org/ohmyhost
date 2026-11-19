export type IssuerDefense = "single-issuer" | "rfc9207" | "signed-response";
export interface ProviderRegistration {
  provider: string;
  adapterVersion: string;
  registration: string;
  issuer: string;
  redirectUri: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
  jwksUri: string;
  clientSecretReference: string;
  allowedScopes: readonly string[];
  enabled: boolean;
  issuerDefense: IssuerDefense;
  noncePolicy: "required" | "not_requested";
}

export function validateIssuerCallbackPolicies(
  registrations: readonly Pick<
    ProviderRegistration,
    "issuer" | "redirectUri" | "enabled" | "issuerDefense"
  >[],
): void {
  const callbacks = new Map<string, (typeof registrations)[number][]>();
  for (const registration of registrations) {
    if (!registration.enabled) continue;
    if (registration.issuerDefense === "signed-response")
      throw new Error("issuer_defense_unsupported");
    const group = callbacks.get(registration.redirectUri) ?? [];
    group.push(registration);
    callbacks.set(registration.redirectUri, group);
  }
  for (const group of callbacks.values()) {
    if (
      new Set(group.map((item) => item.issuer)).size > 1 &&
      group.some((item) => item.issuerDefense === "single-issuer")
    ) {
      throw new Error("issuer_defense_required");
    }
  }
  for (const registration of registrations) {
    if (
      registration.enabled &&
      (registration.issuer !== "https://www.make.com" ||
        registration.issuerDefense !== "single-issuer" ||
        ![
          "https://connect.ohmyho.st/oauth/callback",
          "https://dev.connect.ohmyho.st/oauth/callback",
        ].includes(registration.redirectUri))
    )
      throw new Error("issuer_defense_unsupported");
  }
}

/** Retain existing grants without accepting foreign environments or a stale current registration. */
export function supportsMakeGrantRegistration(
  environment: "development" | "production",
  current: string,
  stored: string,
): boolean {
  return (
    current === `make-${environment}-3` &&
    (stored === current || stored === `make-${environment}-2` || stored === `make-${environment}-1`)
  );
}

export function makeRegistration(environment: "development" | "production"): ProviderRegistration {
  return {
    provider: "make",
    adapterVersion: "1",
    registration: `make-${environment}-3`,
    issuer: "https://www.make.com",
    redirectUri:
      environment === "production"
        ? "https://connect.ohmyho.st/oauth/callback"
        : "https://dev.connect.ohmyho.st/oauth/callback",
    authorizationEndpoint: "https://www.make.com/oauth/v2/authorize",
    tokenEndpoint: "https://www.make.com/oauth/v2/token",
    revocationEndpoint: "https://www.make.com/oauth/v2/revoke",
    jwksUri: "https://www.make.com/oauth/v2/oidc/jwks",
    clientSecretReference: "MAKE_CLIENT_SECRET",
    enabled: true,
    issuerDefense: "single-issuer",
    noncePolicy: "not_requested",
    allowedScopes: [
      "apps:read",
      "scenarios:read",
      "scenarios:write",
      "connections:write",
      "sdk-apps:read",
      "sdk-apps:write",
      "scenarios:run",
      "credential-requests:read",
      "scenarios-shared:read",
      "scenarios-shared:write",
      "credential-requests:write",
      "endpoints:read",
      "endpoints:run",
      "openid",
      "profile",
      "email",
      "organizations:read",
      "teams:read",
      "connections:read",
    ],
  };
}
