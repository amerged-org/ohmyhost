import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { expect, it } from "vitest";

it("serves the bounded Production RPC class and private 404 without Native bindings or extra RPCs", async () => {
  const [bounded, full] = await Promise.all([
    readFile(
      new URL("../dist/production-keyring-bundle/production-keyring-worker.js", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../dist/worker-bundle/worker-main.js", import.meta.url), "utf8"),
  ]);
  const serviceNames = [
    "DEV_ACCESS",
    "RUNTIME_PROBES",
    "GENERAL_CF_RUNTIME",
    "SCOPED_DNS_RUNTIME",
    "APPLICATION_IDENTITY_RUNTIME",
    "MAIL_DNS_RUNTIME",
  ];
  const coreNames = [
    "claimAuthorization",
    "consumeAuthorization",
    "putGrant",
    "configureDomains",
    "readGrant",
    "claimGrantUse",
    "renewGrantUse",
    "finishGrantUse",
    "releaseGrantUse",
    "admitPaidProjectDomain",
    "readPaidDomainTarget",
    "claimPaidDomainApply",
    "putPaidDomainActive",
    "readPaidDomainRecord",
    "readPaidDomainProof",
    "ensurePaidDomainProof",
    "verifyPaidDomainProof",
    "claimPaidDomainDelete",
    "markPaidDomainDeleted",
    "claimPaidProjectDeletion",
    "readReconciliation",
    "rotateGrant",
    "readDeletion",
    "rotateDeletionGrant",
    "prepareRevocation",
    "restartRevocation",
    "finalizeDeletion",
    "finalizePlatformDeletion",
    "issue",
    "status",
    "revoke",
    "consume",
    "saveGrant",
    "claimUse",
    "renewUse",
    "authorizeUse",
    "finishUse",
    "releaseUse",
    "readCleanup",
    "completeEmptyCleanup",
    "declare",
    "replay",
    "readForVerification",
    "completeAction",
    "readAutomatic",
    "completeAutomatic",
    "workspace",
    "deletion",
    "requirePaid",
    "saveWorkspace",
    "saveLegacy",
    "issueRuntimeProbe",
    "beginProbe",
  ];
  const values = {
    RUNTIME_CONFIGURATION_STATE: "configured",
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_PLATFORM_ZONE_ID: "c".repeat(32),
    CLOUDFLARE_SAAS_ZONE_ID: "b".repeat(32),
    CLOUDFLARE_SAAS_CNAME_TARGET: "customers.ohmyho.st",
    CLOUDFLARE_SAAS_API_TOKEN: "fixture-saas-domain-token-value",
    CLOUDFLARE_OAUTH_CLIENT_ID: "fixture-client",
    CLOUDFLARE_OAUTH_CLIENT_SECRET: "fixture-client-secret",
    CLOUDFLARE_OAUTH_REDIRECT_URI: "https://app.ohmyho.st/v1/cloudflare/oauth/callback",
    CLOUDFLARE_OAUTH_STATE_FORMAT: "json-v1",
    CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_BASE64: Buffer.alloc(32, 0x43).toString("base64"),
    CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_VERSION: "20261106",
    CLOUDFLARE_OAUTH_TOKEN_CIPHER_ADDITIONAL_KEYS_JSON: JSON.stringify({
      1: Buffer.alloc(32, 0x41).toString("base64"),
    }),
    CLOUDFLARE_PLATFORM_WEB_DOMAIN_API_TOKEN: "fixture-platform-domain-token",
  };
  const services = Object.fromEntries(
    serviceNames.map((name) => [name, { name: "core", entrypoint: "Core" }]),
  );
  const module = (name: string, contents: string) => ({
    type: "ESModule" as const,
    path: fileURLToPath(new URL(name, import.meta.url)),
    contents,
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: "client",
          compatibilityDate: "2026-08-29",
          modules: [
            module(
              "./keyring-client.mjs",
              `
      const scope={organizationId:'01ARZ3NDEKTSV4RRFFQ69G5FAV',projectId:'01ARZ3NDEKTSV4RRFFQ69G5FAW',actorId:'user:owner'};
      export default {async fetch(request,env){
        const path=new URL(request.url).pathname;
        if(path==='/status')return Response.json(await env.LEGACY.getStatus(scope));
        if(path==='/http')return env.HTTP.fetch(request);
        if(path==='/full'){try{await env.FULL.getStatus(scope);return Response.json({denied:false});}catch{return Response.json({denied:true});}}
        const names=['readDomainPolicySync','ackDomainPolicySync','beginPaidDomainRecovery','completePaidDomainRecovery','applyRealmPolicy','getBindings'];
        let denied=0;for(const name of names){try{await env.LEGACY[name](scope);}catch{denied++;}}
        return Response.json({denied,expected:names.length});
      }};
    `,
            ),
          ],
          serviceBindings: {
            LEGACY: { name: "bounded", entrypoint: "CloudflareDomainManagementService" },
            FULL: { name: "full", entrypoint: "CloudflareDomainManagementService" },
            HTTP: "bounded",
          },
        },
        {
          name: "bounded",
          compatibilityDate: "2026-08-29",
          compatibilityFlags: ["nodejs_compat"],
          modules: [module("./bounded-domain.mjs", bounded)],
          bindings: values,
          serviceBindings: services,
        },
        {
          name: "full",
          compatibilityDate: "2026-08-29",
          compatibilityFlags: ["nodejs_compat"],
          modules: [module("./full-domain.mjs", full)],
          bindings: values,
          serviceBindings: services,
        },
        {
          name: "core",
          compatibilityDate: "2026-08-29",
          modules: [
            module(
              "./keyring-core.mjs",
              `
      import {WorkerEntrypoint} from 'cloudflare:workers';
      export class Core extends WorkerEntrypoint {
        readStatus(){return {status:'not_authorized',zone:null,scopes:[],expiresAt:null}}
        readAuthorization(){return null} read(){return null} legacy(){return null}
        ${coreNames.map((name) => `${name}(){throw new Error('Unexpected existing Core operation: ${name}')}`).join("\n")}
      }
      export default {fetch(){return new Response(null,{status:404})}};
    `,
            ),
          ],
        },
      ],
    }),
  );
  try {
    const status = await mf.dispatchFetch("https://client.example/status");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      status: "not_authorized",
      zone: null,
      scopes: [],
      expiresAt: null,
    });
    expect((await mf.dispatchFetch("https://client.example/http")).status).toBe(404);
    expect(await (await mf.dispatchFetch("https://client.example/full")).json()).toEqual({
      denied: true,
    });
    expect(await (await mf.dispatchFetch("https://client.example/closed")).json()).toEqual({
      denied: 6,
      expected: 6,
    });
  } finally {
    await mf.dispose();
  }
}, 60_000);
