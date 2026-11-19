# Foundation rationale

The six original ADRs are retained as immutable design history under `docs/plan/history/decisions-originals/`. Their rationale informs the current decisions below, but their old provider and acceptance snapshots do not override the [current architecture](../index.md) or plan registry.

## Modular monolith — ADR-001

Keep one strict TypeScript domain model in a pnpm monorepo, with modules owning their data and depending on narrow ports. Deployables isolate actual runtime/trust boundaries; they do not create a second business model or distributed transaction scheme. This preserves independent provider adapters without a premature service per domain. See [D001–D006](foundations.md#d001) and [operative development rules](../../development.md). Original ADR.

## Cloudflare runtime — ADR-002

Cloudflare supplies the customer Worker/static-asset runtime, routing, storage and private orchestration boundaries. Customer code receives project capabilities without management credentials or Control Workflow authority. Builds now use Cloudflare sandboxes, managed mail uses Resend and recovery uses a private Cloudflare Container: the earlier AWS build/mail assumption is superseded by D347. A private platform Container is not a customer-container hosting product. See [D045](runtime-and-lifecycle.md#d045), [D249](source-and-build.md#d249), [D250](runtime-and-lifecycle.md#d250) and [D347](delivery-and-operations.md#d347). Original ADR.

## Database isolation — ADR-003

Separate customer data at a provider resource boundary rather than a shared multi-tenant schema. The former single project/root-plus-preview description has evolved into explicit shared or isolated logical-environment assignments to physical data identities; changes freeze exact assignment/registration versions and do not silently copy rows. Runtime, migration and direct customer-access roles remain separate. Ordinary deployed application access uses the private regional database capability; it does not receive the reusable provider URL. Customer exports now contain plain SQL in password-encrypted ZIPs, rather than custom-format dumps or user S3/Drive destinations. See [D255](data.md#d255), [D383](data.md#d383), [D385](data.md#d385), [database architecture](../database.md) and [D124–D133](files-functions-recovery.md#d124). Original ADR.

## Local credit authority — ADR-004

Keep the credit amounts, effective-time integer prices and transactional reservations/settlement in the Core. Since W33 the Core holds one credit account per organization and the reason for each change is a log row kept for one day in the Core and 14 days in R2 ([D445](billing-and-usage.md#d445)). Usage billing cannot become a deployment prerequisite. Provider outages do not invent zero consumption or erase uncertain accepted work. OpenMeter remains a conditional derived sink rather than an enforcement authority. See [billing/usage decisions](billing-and-usage.md) and the [pricing contract](../pricing-contract.md). Original ADR.

## Independent recovery — ADR-005

The recovery principle is to preserve roots needed to operate or restore the platform without depending on a healthy managed Control path: domain authority, Git/CI, infrastructure state, identity/billing and external Control recovery. Required backup, direct-deployer or recovery-drill evidence stays required until actually demonstrated. Infisical custody, KMS and the old bootstrap topology are not proof of a deployed system or a currently used customer-secret store. Current customer runtime-secret values are encrypted Control records with separate Worker-held keys. See [security](../security/index.md), [secret custody](../auth-and-secrets.md#customer-runtime-secrets) and [D134](files-functions-recovery.md#d134). Original ADR.

## One authorization decision authority — ADR-006

WorkOS supplies verified identities, sessions, organizations and membership facts; local Control grants behind AuthorizationPort decide product actions. Exact principal/organization/project/environment, ownership/lifecycle and permission ceilings bind each action. Ambiguous or stale scope fails closed. The original private-sandbox matrix and FGA candidate are design history; later user-key/profile/data contracts must be read from their current decisions and code. Do not introduce simultaneous FGA/local allow evaluation or treat public discovery, a provider login or an API-key permission list as broader tenant authority. See [identity decisions](identity.md), [platform access](../auth-and-secrets.md#platform-login-and-api-tokens) and [security boundaries](../security/index.md). Original ADR.
