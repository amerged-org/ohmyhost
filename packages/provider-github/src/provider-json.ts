import { GithubProviderContractError } from "./errors.js";

export async function readBoundedProviderBytes(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const declared = response.headers.get("Content-Length");
  const contentEncoding = response.headers.get("Content-Encoding")?.trim().toLowerCase();
  const decodedLengthIsDeclared = contentEncoding === undefined || contentEncoding === "identity";
  let declaredLength: number | undefined;
  if (declared !== null) {
    if (!/^[1-9]\d*$/u.test(declared)) throw new GithubProviderContractError();
    declaredLength = Number(declared);
    if (
      !Number.isSafeInteger(declaredLength) ||
      (decodedLengthIsDeclared && declaredLength > maximumBytes)
    ) {
      throw new GithubProviderContractError();
    }
  }
  if (response.body === null) throw new GithubProviderContractError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel();
        throw new GithubProviderContractError();
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof GithubProviderContractError) throw error;
    throw new GithubProviderContractError();
  }
  if (
    byteLength === 0 ||
    (decodedLengthIsDeclared && declaredLength !== undefined && byteLength !== declaredLength)
  ) {
    throw new GithubProviderContractError();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedProviderText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await readBoundedProviderBytes(response, maximumBytes),
    );
  } catch (error) {
    if (error instanceof GithubProviderContractError) throw error;
    throw new GithubProviderContractError();
  }
}

export async function readBoundedProviderJson(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  try {
    return JSON.parse(await readBoundedProviderText(response, maximumBytes));
  } catch (error) {
    if (error instanceof GithubProviderContractError) throw error;
    throw new GithubProviderContractError();
  }
}
