# `@ohmyhost/sdk-ts`

Typed management REST client for ohmyho.st. Install the public package with the exact client
release used by the application:

```sh
npm install @amerged/ohmyhost-sdk@<version>
```

## Received-mail attachments

`downloadManagedMailAttachment(client, input)` uses the authenticated management GET route and
preserves its binary stream instead of invoking the generated binary-to-Blob parser. Use an
access token authorized for the concrete project and environment; runtime mail keys belong in
`@ohmyhost/customer-runtime` instead.

```ts
import { createClient, downloadManagedMailAttachment } from "@amerged/ohmyhost-sdk";

const client = createClient({
  baseUrl: "https://app.ohmyho.st",
  headers: { authorization: `Bearer ${accessToken}` },
});
const result = await downloadManagedMailAttachment(client, {
  projectId,
  environmentId,
  messageId,
  attachmentId,
  signal: request.signal,
});
if (result.status === "expired") return Response.json({ status: "expired" });
return result.response;
```

The result is `{ status: "download", response, body }`, where `body` is the original
`ReadableStream<Uint8Array>`, or the existing `{ status: "expired" }` JSON result. The helper
validates canonical scope identifiers and bounded expired JSON. Normal HTTP/API errors retain
the generated client's error behavior.

Consume `body` to EOF to establish success, or cancel it to release the transfer. Cancellation
propagates upstream; do not call `blob()`, `arrayBuffer()` or `tee()` when forwarding a large
attachment. The gateway keeps the 72-hour access window, 50 MiB ceiling and 15-second transfer
deadline. An ownership change, expiry, truncated/oversized body or deadline after headers fails
the stream; HTTP 200 alone does not establish a complete download.

API and customer guides: [Documentation](https://docs.ohmyho.st/),
[Email](https://docs.ohmyho.st/email).
