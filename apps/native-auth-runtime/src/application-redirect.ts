import {
  isNativeAuthRedirectPath,
  NATIVE_AUTH_DEFAULT_REDIRECT_PATHS,
} from "@ohmyhost/contracts/native-auth";

/** Owner-approved application forms own all success and failure navigation. */
export function nativeApplicationFallbackPath(
  allowedPaths: readonly string[] = NATIVE_AUTH_DEFAULT_REDIRECT_PATHS,
): string {
  const first = allowedPaths[0];
  if (first === undefined || allowedPaths.some((path) => !isNativeAuthRedirectPath(path)))
    throw new TypeError("invalid_native_auth_redirect_paths");
  return allowedPaths.includes("/login") ? "/login" : first;
}
