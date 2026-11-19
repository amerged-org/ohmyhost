import { createRequire, builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { D1Database } from "../../../control-store/src/d1-types.js";
import { migrate, activateTestCore } from "../../../control-store/test/support/control-d1.js";
import { CORE_DATABASE_ID, seedManagementScope } from "./d1-pgcf-scope.js";
import { id, type pgcfFixture } from "../pgcf-runtime-fixture.js";
const root = fileURLToPath(new URL("../../../../", import.meta.url));
export async function bundleManagementFixture(contents: string) {
  const out = await build({
    stdin: { contents, resolveDir: root, loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2024",
    conditions: ["source", "workerd", "worker", "browser"],
    mainFields: ["browser", "module", "main"],
    external: ["cloudflare:workers", "node:*"],
    banner: {
      js: 'import{createRequire as __fixtureRequire}from"node:module";const require=__fixtureRequire("file:///fixture.mjs");',
    },
    plugins: [
      {
        name: "native-builtins",
        setup(builder) {
          builder.onResolve({ filter: /^[^.:/][^:]*$/ }, (args) =>
            builtinModules.includes(args.path)
              ? { path: `node:${args.path}`, external: true }
              : undefined,
          );
        },
      },
    ],
    write: false,
    logLevel: "error",
  });
  const result = out.outputFiles[0];
  if (result === undefined) throw new Error("empty worker bundle");
  return result.text;
}
type Fixture = Awaited<ReturnType<typeof pgcfFixture>>;
export async function managementWorkerFixture(
  f: Fixture,
  options: { publicApi?: boolean; nativeIntegrated?: boolean } = {},
) {
  const require = createRequire(new URL("../../../control-store/package.json", import.meta.url));
  const { Miniflare, convertV4MiniflareOptions } = createRequire(
    require.resolve("wrangler/package.json"),
  )("miniflare") as {
    Miniflare: new (opts: unknown) => {
      getD1Database(binding: string, worker: string): Promise<unknown>;
      getWorker(
        worker: string,
      ): Promise<{ fetch(url: string, init?: RequestInit): Promise<Response> }>;
      dispose(): Promise<void>;
    };
    convertV4MiniflareOptions(opts: unknown): unknown;
  };
  const sessions = new Map<string, Awaited<ReturnType<Fixture["connect"]>>>();
  const sessionRoles = new Map<string, string>();
  const migrationSessions = new Set<string>();
  let loseCommitForRole: string | undefined;
  let loseStatement: { role: string; sql: string } | undefined;
  let seq = 0;
  const appErrors: string[] = [];
  let registryNetwork = 0;
  const queries: string[] = [];
  const script =
    await bundleManagementFixture(`import{NeonManagementService}from"./apps/neon-management/src/worker-main.ts";
 function revive(value){if(value&&typeof value==='object'&&typeof value.__fixtureDate==='string')return new Date(value.__fixtureDate);if(value&&value.type==='Buffer'&&Array.isArray(value.data))return Uint8Array.from(value.data);if(Array.isArray(value))return value.map(revive);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,revive(v)]));return value}let pools=0;
 const request=async(path,data)=>{const r=await fetch('https://app-sql.fixture/'+path,{method:'POST',body:JSON.stringify(data)});const result=await r.json();if(!r.ok)throw Object.assign(new Error(result.error),{code:result.code,name:result.name,severity:result.severity});return revive(result)};
 const connect=async(uri,target)=>{const{session}=await request('connect',{uri,target});return{client:{query:(sql,parameters=[])=>request('query',{session,sql,parameters})},close:()=>request('close',{session})}};
 export class Management extends NeonManagementService{constructor(ctx,env){super(ctx,env,connect,async(uri,target)=>{const c=await connect(uri,target);return{close:c.close,client:{query:q=>c.client.query(q)}}},async()=>{})}poolCalls(){return pools}}
 export class Missing extends NeonManagementService{constructor(ctx,env){super(ctx,{...env,DATABASE_MANAGEMENT_RUNTIME:undefined},connect)}}
 export default{fetch(){return new Response('private')}};`);
  const registry =
    await bundleManagementFixture(`import{ProjectDatabaseAdmin as Admin,ProjectDatabaseService as Service}from"./apps/project-database-runtime/src/worker-main.ts";export{ProjectDatabaseEnvironment}from"./apps/project-database-runtime/src/worker-main.ts";
 let loseRegistry=false;
 function local(env){return{...env,DATABASE_ENVIRONMENTS:{jurisdiction(region){if(region!==env.DATABASE_REGION)throw new Error('Unexpected jurisdiction');return env.DATABASE_ENVIRONMENTS}}}}
 export class ProjectDatabaseAdmin extends Admin{constructor(ctx,env){super(ctx,local(env))}armRegistryLoss(){loseRegistry=true}async register(input){const result=await super.register(input);if(loseRegistry){loseRegistry=false;throw new Error('registry reply lost after durable registration')}return result}};export class ProjectDatabaseService extends Service{constructor(ctx,env){super(ctx,local(env))}};export default{fetch(){return new Response('private')}};`);
  const nativeRegistry = options.nativeIntegrated
    ? await bundleManagementFixture(
        `import{connect}from"node:net";import{NativeAuthEnvironment,NativeRegistryAdminService as Registry,NativePublicService as Public}from"./apps/native-auth-runtime/src/realm-worker.ts";import{NativePolicyService as Policy,NativeAdminService as Admin,NativeSessionService as Session}from"./apps/native-auth-runtime/src/worker-main.ts";import{WorkerEntrypoint}from"cloudflare:workers";export{NativeAuthEnvironment};
const upstream=new URL(${JSON.stringify(String(f.control.pool.options.connectionString))});
class FixtureWebSocket extends EventTarget{binaryType='arraybuffer';constructor(url){super();if(!String(url).startsWith('wss://'))throw Error('expected secure websocket');this.socket=connect(Number(upstream.port),'127.0.0.1');this.socket.on('connect',()=>this.dispatchEvent(new Event('open')));this.socket.on('data',b=>this.dispatchEvent(new MessageEvent('message',{data:Uint8Array.from(b).buffer})));this.socket.on('error',()=>this.dispatchEvent(new Event('error')));this.socket.on('close',()=>this.dispatchEvent(new Event('close')))}send(b){this.socket.write(b)}close(){this.socket.end()}}globalThis.WebSocket=FixtureWebSocket;
function local(env){return{...env,NATIVE_AUTH_ENVIRONMENTS:{jurisdiction(){return env.NATIVE_AUTH_ENVIRONMENTS}}}};
export class NativeRegistryAdminService extends Registry{constructor(ctx,env){super(ctx,local(env))}};
export class NativePolicyService extends Policy{constructor(ctx,env){super(ctx,local(env))}};
export class NativeAdminService extends Admin{constructor(ctx,env){super(ctx,local(env))}};
export class NativePublicService extends Public{constructor(ctx,env){super(ctx,local(env))}};
export class FixtureSession extends WorkerEntrypoint{validate(scope,cookie){return new Session({props:scope},local(this.env)).validateSession({cookie})}};
export default{fetch(){return new Response('private')}};`,
      )
    : await bundleManagementFixture(
        `import{WorkerEntrypoint}from"cloudflare:workers";import{NativeAuthEnvironment as Environment,NativeRegistryAdminService as Admin,realm}from"./apps/native-auth-runtime/src/realm-worker.ts";export class NativeAuthEnvironment extends Environment{async custodyFields(){return Object.keys(await this.ctx.storage.get('registration')??{}).sort()}};export class NativeRegistryAdminService extends Admin{constructor(ctx,env){super(ctx,{...env,NATIVE_AUTH_ENVIRONMENTS:{jurisdiction(){return env.NATIVE_AUTH_ENVIRONMENTS}}})}custodyFields(scope){return realm(this.env,scope).custodyFields()}};export class NativeAdminService extends WorkerEntrypoint{applyRealmPolicy(){return {outcome:'applied'}}};export default{fetch(){return new Response('private')}};`,
      );
  const scope = {
    organizationId: id(1),
    projectId: id(2),
    physicalEnvironmentId: id(4),
    region: "us",
  };
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: "core",
          modules: true,
          script: await bundleManagementFixture(
            'export{DatabaseManagementRuntime,DatabaseProductRuntime,ControlRuntime,NativeAuthResourceRuntime,NativeAuthDeletionRuntime,NativeAuthRegistryAuthorityRuntime,NativeAuthRuntime,NativeAuthAdminAuthorityRuntime,NativeAuthMailRuntime,MailSendRuntime}from"./apps/control-store/src/worker-main.ts";export default{fetch(){return new Response("private")}}',
          ),
          compatibilityDate: "2026-08-24",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: { CONTROL_CORE: "management-core" },
          bindings: {
            CONTROL_CORE_DATABASE_ID: CORE_DATABASE_ID,
            CONTROL_PLATFORM_ENVIRONMENT: "development",
            CONTROL_NATIVE_AUTH_LAUNCH_POLICY: '{"mode":"password-general-availability"}',
          },
        },
        ...["us", "eu"].map((region) => ({
          name: `registry-${region}`,
          modules: true,
          script: registry,
          compatibilityDate: "2026-08-24",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            DATABASE_ENVIRONMENTS: { className: "ProjectDatabaseEnvironment", useSQLite: true },
          },
          bindings: {
            DATABASE_REGION: region,
            DATABASE_REGISTRY_KEY: Buffer.from("k".repeat(32)).toString("base64"),
          },
          outboundService: () => {
            registryNetwork++;
            throw new Error("Unexpected registry network");
          },
        })),
        ...["us", "eu"].map((region) => ({
          name: `native-registry-${region}`,
          modules: true,
          script: nativeRegistry,
          compatibilityDate: "2026-08-24",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            NATIVE_AUTH_ENVIRONMENTS: { className: "NativeAuthEnvironment", useSQLite: true },
          },
          bindings: {
            NATIVE_AUTH_REGION_ID: `${region}-dev`,
            NATIVE_AUTH_CUSTODY_KEY_BASE64: Buffer.from("k".repeat(32)).toString("base64"),
            NATIVE_AUTH_CUSTODY_KEY_VERSION: 1,
          },
          serviceBindings: {
            NATIVE_AUTH_REGISTRY_AUTHORITY: {
              name: "core",
              entrypoint: "NativeAuthRegistryAuthorityRuntime",
            },
            ...(options.nativeIntegrated
              ? {
                  NATIVE_AUTH_AUTHORITY: { name: "core", entrypoint: "NativeAuthRuntime" },
                  NATIVE_AUTH_ADMIN_AUTHORITY: {
                    name: "core",
                    entrypoint: "NativeAuthAdminAuthorityRuntime",
                  },
                  NATIVE_AUTH_MAIL_AUTHORITY: { name: "core", entrypoint: "NativeAuthMailRuntime" },
                  NATIVE_AUTH_MAIL: { name: "native-mail", entrypoint: "NativeAuthMailService" },
                }
              : {}),
          },
          ...(options.nativeIntegrated
            ? {
                ratelimits: {
                  NATIVE_AUTH_GENERAL_LIMITER: {
                    namespace_id: "9701",
                    simple: { limit: 100, period: 60 },
                  },
                  NATIVE_AUTH_SIGNIN_LIMITER: {
                    namespace_id: "9702",
                    simple: { limit: 5, period: 60 },
                  },
                  NATIVE_AUTH_SIGNUP_LIMITER: {
                    namespace_id: "9703",
                    simple: { limit: 3, period: 60 },
                  },
                  NATIVE_AUTH_REALM_LIMITER: {
                    namespace_id: "9705",
                    simple: { limit: 3000, period: 60 },
                  },
                  NATIVE_AUTH_RESET_LIMITER: {
                    namespace_id: "9704",
                    simple: { limit: 3, period: 60 },
                  },
                },
              }
            : {}),
        })),
        ...(options.nativeIntegrated
          ? [
              {
                name: "native-core-client",
                modules: true,
                compatibilityDate: "2026-08-24",
                script: `export default{async fetch(request,env){const {method,input}=await request.json();try{return Response.json({ok:true,result:await env.CORE[method](input)})}catch(error){return Response.json({ok:false,message:error.message})}}}`,
                serviceBindings: {
                  CORE: { name: "core", entrypoint: "NativeAuthResourceRuntime" },
                },
              },
              {
                name: "native-mail",
                modules: true,
                compatibilityDate: "2026-08-24",
                compatibilityFlags: ["nodejs_compat"],
                script: await bundleManagementFixture(
                  `import{WorkerEntrypoint}from"cloudflare:workers";export{NativeAuthMailService}from"./apps/mail-gateway/src/resend-worker.ts";let sent=[];globalThis.fetch=async(input,init)=>{const u=typeof input==='string'?input:input.url;if(u!=='https://api.resend.com/emails'||init?.method!=='POST')throw Error('unexpected provider');sent.push(JSON.parse(init.body));return Response.json({id:'fixture_'+sent.length})};export class MailInspector extends WorkerEntrypoint{read(){return sent}};export default{fetch(){return new Response('private')}};`,
                ),
                bindings: {
                  RUNTIME_CONFIGURATION_STATE: "configured",
                  MAIL_DOMAIN_KEY_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 0x63).toString("base64"),
                },
                serviceBindings: {
                  NATIVE_AUTH_MAIL_AUTHORITY: { name: "core", entrypoint: "NativeAuthMailRuntime" },
                  MAIL_SEND_RUNTIME: { name: "core", entrypoint: "MailSendRuntime" },
                },
              },
            ]
          : []),
        {
          name: "management",
          modules: true,
          script,
          compatibilityDate: "2026-08-24",
          compatibilityFlags: ["nodejs_compat"],
          bindings: {
            RUNTIME_CONFIGURATION_STATE: "configured",
            PGCF_API_URL: "https://pgcf-api.aixyte.com",
            PGCF_APPS_PROJECT_ID: f.provider.projectId,
            PGCF_APPS_API_KEY: "test-only-integrator-key",
          },
          serviceBindings: {
            NATIVE_AUTH_RESOURCE_RUNTIME: { name: "core", entrypoint: "NativeAuthResourceRuntime" },
            NATIVE_AUTH_DELETION_RUNTIME: { name: "core", entrypoint: "NativeAuthDeletionRuntime" },
            NATIVE_AUTH_REGISTRY_AUTHORITY: {
              name: "core",
              entrypoint: "NativeAuthRegistryAuthorityRuntime",
            },
            NATIVE_AUTH_REGISTRY_US: {
              name: "native-registry-us",
              entrypoint: "NativeRegistryAdminService",
            },
            NATIVE_AUTH_REGISTRY_EU: {
              name: "native-registry-eu",
              entrypoint: "NativeRegistryAdminService",
            },
            NATIVE_AUTH_ADMIN_US: {
              name: "native-registry-us",
              entrypoint: options.nativeIntegrated ? "NativePolicyService" : "NativeAdminService",
            },
            NATIVE_AUTH_ADMIN_EU: {
              name: "native-registry-eu",
              entrypoint: options.nativeIntegrated ? "NativePolicyService" : "NativeAdminService",
            },
            DATABASE_MANAGEMENT_RUNTIME: { name: "core", entrypoint: "DatabaseManagementRuntime" },
            DATABASE_PRODUCT_RUNTIME: { name: "core", entrypoint: "DatabaseProductRuntime" },
            PROJECT_DATABASE_ADMIN_US: { name: "registry-us", entrypoint: "ProjectDatabaseAdmin" },
            PROJECT_DATABASE_ADMIN_EU: { name: "registry-eu", entrypoint: "ProjectDatabaseAdmin" },
          },
          outboundService: async (request: Request) => {
            const url = new URL(request.url);
            if (url.hostname === "pgcf-api.aixyte.com")
              return f.providerFetch(request.url, {
                method: request.method,
                headers: request.headers,
                ...(request.method === "GET" ? {} : { body: await request.text() }),
              });
            if (url.hostname !== "app-sql.fixture") throw new Error("Unexpected provider boundary");
            const input = (await request.json()) as {
              session?: string;
              uri?: string;
              target?: Parameters<Fixture["connect"]>[1];
              sql?: string | { text: string; values: unknown[]; queryMode: "extended" };
              parameters?: unknown[];
            };
            try {
              if (url.pathname === "/connect") {
                if (input.uri === undefined || input.target === undefined)
                  throw new Error("connection missing");
                const session = String(++seq);
                sessions.set(session, await f.connect(input.uri, input.target));
                sessionRoles.set(session, input.target.role);
                return Response.json({ session });
              }
              const connection = sessions.get(String(input.session));
              if (connection === undefined) throw new Error("unknown app session");
              if (url.pathname === "/query") {
                if (
                  typeof input.sql !== "string" &&
                  !(
                    input.sql &&
                    typeof input.sql.text === "string" &&
                    input.sql.queryMode === "extended" &&
                    Array.isArray(input.sql.values)
                  )
                )
                  throw new Error("query missing");
                queries.push(typeof input.sql === "string" ? input.sql : input.sql.text);
                if (
                  typeof input.sql === "string" &&
                  input.sql.startsWith("CREATE TABLE IF NOT EXISTS ohmyhost.schema_migrations")
                )
                  migrationSessions.add(String(input.session));
                const result = await connection.client.query(
                  input.sql as string,
                  typeof input.sql === "string"
                    ? (input.parameters ?? []).map((value) =>
                        typeof value === "object" &&
                        value !== null &&
                        Reflect.get(value, "type") === "Buffer"
                          ? Buffer.from(Reflect.get(value, "data") as number[])
                          : value,
                      )
                    : undefined,
                );
                // Migration statements arrive as extended-protocol objects, so the loss matches their text.
                const statementText = typeof input.sql === "string" ? input.sql : input.sql?.text;
                if (
                  loseStatement !== undefined &&
                  statementText === loseStatement.sql &&
                  sessionRoles.get(String(input.session)) === loseStatement.role
                ) {
                  loseStatement = undefined;
                  throw Object.assign(new Error("lost statement response"), { code: "EPIPE" });
                }
                if (
                  input.sql === "COMMIT" &&
                  migrationSessions.has(String(input.session)) &&
                  loseCommitForRole !== undefined &&
                  sessionRoles.get(String(input.session)) === loseCommitForRole
                ) {
                  loseCommitForRole = undefined;
                  throw Object.assign(new Error("lost committed response"), { code: "42P01" });
                }
                const encode = (value: unknown): unknown =>
                  value instanceof Date
                    ? { __fixtureDate: value.toISOString() }
                    : value instanceof Uint8Array
                      ? { type: "Buffer", data: Array.from(value) }
                      : Array.isArray(value)
                        ? value.map(encode)
                        : value !== null && typeof value === "object"
                          ? Object.fromEntries(
                              Object.entries(value).map(([key, item]) => [key, encode(item)]),
                            )
                          : value;
                return Response.json(encode(result));
              }
              if (url.pathname === "/close") {
                await connection.close();
                sessions.delete(String(input.session));
                sessionRoles.delete(String(input.session));
                migrationSessions.delete(String(input.session));
                return Response.json({ closed: true });
              }
              throw new Error("unknown app operation");
            } catch (error) {
              appErrors.push(
                `${(typeof input.sql === "string" ? input.sql : input.sql?.text)?.slice(0, 100) ?? url.pathname}: ${error instanceof Error ? error.message : String(error)}`,
              );
              return Response.json(
                {
                  error: error instanceof Error ? error.message : String(error),
                  name: error instanceof Error ? error.name : undefined,
                  severity:
                    typeof error === "object" && error !== null && "severity" in error
                      ? error.severity
                      : undefined,
                  code:
                    typeof error === "object" && error !== null && "code" in error
                      ? error.code
                      : undefined,
                },
                { status: 500 },
              );
            }
          },
        },
        ...(options.publicApi
          ? [
              {
                name: "product-auth",
                modules: true,
                compatibilityDate: "2026-08-24",
                script: `export default{async fetch(request){const{value}=await request.json();const user=value==="sk_aaaaaaaaaaaaaaaaaaaaaaaa"?"user_productfixture":value==="sk_bbbbbbbbbbbbbbbbbbbbbbbb"?"user_productmember":null;return Response.json({key:user?{id:"api_key_productfixture",userId:user,organizationId:"org_management_fixture",permissions:["projects:read","projects:write","operations:read"],expiresAt:null}:null},{headers:{"cache-control":"no-store"}})}}`,
              },
              {
                name: "product-api",
                modules: true,
                compatibilityDate: "2026-08-24",
                compatibilityFlags: ["nodejs_compat"],
                script: await bundleManagementFixture(
                  `import{createControlApiWorkerEntrypoint}from"./apps/control-api/src/worker-main.ts";const forbidden=()=>{throw new Error("FETCH_FORBIDDEN")};const worker=createControlApiWorkerEntrypoint({fetcher:forbidden});export default{async fetch(request,env,ctx){const url=new URL(request.url);const bindings={...env,CONTROL_API_PUBLIC_ORIGIN:"https://dev.app.ohmyho.st",CONTROL_API_RATE_LIMITER:{limit:async()=>({success:true})},OPERATION_PUBLISHER:{wake:async()=>{}},WORKOS_JWKS_URL:"https://fixture.authkit.app/jwks",WORKOS_ISSUER:"https://api.workos.com/user_management/client_fixture",WORKOS_CLIENT_ID:"client_fixture",WORKOS_AUDIENCE:"control-api"};if(request.headers.get("x-fixture-mode")==="missing")delete bindings.CONTROL_RUNTIME;if(url.pathname==="/fixture/scheduled")return Response.json(await worker.scheduled({cron:"* * * * *",scheduledTime:Date.now()},bindings,ctx));return worker.fetch(request,bindings,ctx)}}`,
                ),
                serviceBindings: {
                  CONTROL_RUNTIME: { name: "core", entrypoint: "ControlRuntime" },
                  DATABASE_PRODUCT_RUNTIME: { name: "core", entrypoint: "DatabaseProductRuntime" },
                  NEON_MANAGEMENT: { name: "management", entrypoint: "Management" },
                  AUTH_STATUS: "product-auth",
                },
              },
            ]
          : []),
        {
          name: "caller",
          modules: true,
          script: `export default{async fetch(request,env){const{action,input}=await request.json();if(input?.migrations)for(const m of input.migrations)m.body=Uint8Array.from(m.body);try{let result;if(action==='nativeCustodyFields')result=await (input.region==='eu'?env.NATIVE_REGISTRY_EU:env.NATIVE_REGISTRY_US).custodyFields(input);else if(action==='nativeDomainRead')result=await env.NATIVE_CORE.readDomainPolicySync(input);else if(action==='nativeDomainAck')result=await env.NATIVE_CORE.ackDomainPolicySync(input);else if(action==='nativeProvisioningPolicy')result=await env.NATIVE_CORE.readProvisioningPolicy(input);else if(action==='nativePending')result=await env.NATIVE_CORE.readPendingNativePolicySync(input);else if(action==='nativeComplete')result=await env.NATIVE_CORE.completeNativePolicySync(input);else if(action==='nativePolicy'||action==='nativePolicyUs')result=await env.NATIVE_POLICY.applyRealmPolicy(input);else if(action==='nativePolicyEu')result=await env.NATIVE_POLICY_EU.applyRealmPolicy(input);else if(action==='nativeAdminPolicyEu')result=await env.NATIVE_ADMIN_EU.applyRealmPolicy(input);else if(action==='nativeSession')result=await (input.region==='eu'?env.NATIVE_SESSION_EU:env.NATIVE_SESSION).validate(input.scope,input.cookie);else if(action==='nativeMails')result=await env.NATIVE_MAIL_INSPECTOR.read();else if(action==='nativeFetch'){const r=await (input.region==='eu'?env.NATIVE_PUBLIC_EU:env.NATIVE_PUBLIC).fetchPublic(new Request(input.url,{method:input.method,headers:input.headers,body:input.body}),input.scope,{clientAddress:'192.0.2.44'});result={status:r.status,location:r.headers.get('location'),cookies:r.headers.getSetCookie(),body:await r.text()}}else if(action==='loseRegistry'){await env.ADMIN.armRegistryLoss();result=true}else if(action==='pool')result=await env.MANAGEMENT.poolCalls();else if(action==='authority')result=await env.CORE.readControlAuthority();else if(action==='missing')result=await env.MISSING.placeProject(input);else if(action==='inspect')result=await env.ADMIN.inspect(input);else if(action==='oldQuery')result=await env.OLD.query(input);else if(action==='rebind')result=await env.ADMIN.rebind(input);else result=await env.MANAGEMENT[action](input);return Response.json({ok:true,result})}catch(error){return Response.json({ok:false,message:error.message})}}}`,
          compatibilityDate: "2026-08-24",
          serviceBindings: {
            MANAGEMENT: { name: "management", entrypoint: "Management" },
            NATIVE_REGISTRY_US: {
              name: "native-registry-us",
              entrypoint: "NativeRegistryAdminService",
            },
            NATIVE_REGISTRY_EU: {
              name: "native-registry-eu",
              entrypoint: "NativeRegistryAdminService",
            },
            MISSING: { name: "management", entrypoint: "Missing" },
            CORE: { name: "core", entrypoint: "DatabaseManagementRuntime" },
            ADMIN: { name: "registry-us", entrypoint: "ProjectDatabaseAdmin" },
            OLD: {
              name: "registry-us",
              entrypoint: "ProjectDatabaseService",
              props: { ...scope, environmentId: id(4), registrationVersion: 1 },
            },
            ...(options.nativeIntegrated
              ? {
                  NATIVE_CORE: { name: "core", entrypoint: "NativeAuthResourceRuntime" },
                  NATIVE_POLICY: { name: "native-registry-us", entrypoint: "NativePolicyService" },
                  NATIVE_POLICY_EU: {
                    name: "native-registry-eu",
                    entrypoint: "NativePolicyService",
                  },
                  NATIVE_ADMIN_EU: {
                    name: "native-registry-eu",
                    entrypoint: "NativeAdminService",
                  },
                  NATIVE_PUBLIC: { name: "native-registry-us", entrypoint: "NativePublicService" },
                  NATIVE_PUBLIC_EU: {
                    name: "native-registry-eu",
                    entrypoint: "NativePublicService",
                  },
                  NATIVE_SESSION: { name: "native-registry-us", entrypoint: "FixtureSession" },
                  NATIVE_SESSION_EU: { name: "native-registry-eu", entrypoint: "FixtureSession" },
                  NATIVE_MAIL_INSPECTOR: { name: "native-mail", entrypoint: "MailInspector" },
                }
              : {}),
          },
        },
      ],
    }),
  );
  try {
    const core = (await mf.getD1Database("CONTROL_CORE", "core")) as D1Database;
    await migrate(core, "core");
    await activateTestCore(core);
    await seedManagementScope(core);
    if (options.publicApi) {
      await core.batch([
        core
          .prepare(
            "UPDATE organizations SET beta_admitted_at='2026-10-28T12:00:00.000000Z' WHERE organization_id=?",
          )
          .bind(id(1)),
        ...[
          ["user_productfixture", "admin", "owner", id(90)],
          ["user_productmember", "member", "member", id(91)],
        ].flatMap(([user, role, grant, grantId]) => [
          core
            .prepare(
              "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,?2,?3,'active',1,zeroblob(32),'2026-10-28T12:00:00.000000Z','evt_product')",
            )
            .bind(id(1), user, role),
          core
            .prepare(
              "INSERT INTO local_authorization_grants(organization_id,grant_id,principal_kind,principal_id,role,created_at) VALUES(?1,?2,'user',?3,?4,'2026-10-28T12:00:00.000000Z')",
            )
            .bind(id(1), grantId, "user:" + user, grant),
        ]),
      ]);
    }
    const api = options.publicApi ? await mf.getWorker("product-api") : undefined;
    const caller = await mf.getWorker("caller");
    const nativeCore = options.nativeIntegrated
      ? await mf.getWorker("native-core-client")
      : undefined;
    return {
      core,
      api,
      appErrors,
      queries,
      loseNextCommit(role: string) {
        loseCommitForRole = role;
      },
      loseNextStatement(role: string, sql: string) {
        loseStatement = { role, sql };
      },
      registryRequests: () => registryNetwork,
      async callNativeCore(method: string, input: unknown) {
        if (!nativeCore) throw new Error("native fixture unavailable");
        return (
          await nativeCore.fetch("https://fixture/", {
            method: "POST",
            body: JSON.stringify({ method, input }),
          })
        ).json() as Promise<{ ok: boolean; result?: unknown; message?: string }>;
      },
      async call(action: string, input: unknown = {}) {
        return (
          await caller.fetch("https://fixture/", {
            method: "POST",
            body: JSON.stringify({ action, input }),
          })
        ).json() as Promise<{ ok: boolean; result?: unknown; message?: string }>;
      },
      async dispose() {
        for (const connection of sessions.values()) await connection.close();
        await mf.dispose();
      },
    };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
