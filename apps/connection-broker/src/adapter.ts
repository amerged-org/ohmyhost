import type { ProviderRegistration } from "./registry.js";
export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresIn: number;
  /** Undefined means the provider omitted scope; an empty array means no verified scopes. */
  scopes?: readonly string[];
}
/** A bounded OAuth error proves that the authorization code was rejected. */
export class KnownExchangeRejection extends Error {
  constructor() {
    super("provider_authorization_denied");
  }
}
/** Implementations are selected only from the reviewed server registry, never a browser URL. */
export interface ProviderAdapter {
  authorizationUrl(
    registration: ProviderRegistration,
    clientId: string,
    state: string,
    verifier: string,
    nonce: string | null,
  ): Promise<string>;
  exchange(
    registration: ProviderRegistration,
    client: OAuthClient,
    code: string,
    verifier: string,
  ): Promise<OAuthTokens>;
  refresh(
    registration: ProviderRegistration,
    client: OAuthClient,
    refreshToken: string,
  ): Promise<OAuthTokens>;
  revoke(
    registration: ProviderRegistration,
    client: OAuthClient,
    refreshToken: string,
  ): Promise<void>;
  verifyIdentity(idToken: string, clientId: string, nonce: string | null): Promise<string>;
}
