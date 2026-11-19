# Resend alternative that sends from the same balance as your hosting

ohmyho.st meters transactional mail per recipient, about {{ credits unit.thousandMailRecipients dp=0 }} per 1,000, with no separate sender-domain charge. Resend is the upstream provider: ohmyho.st manages customer domains, keys, webhooks and billing in its platform account. Using Resend directly instead means managing your own account and API key. Resend Free covers {{ text vendor.resend.free.includes }}; Pro is {{ usd vendor.resend.pro }} for 50,000.

{{ figure bills.resend }}

## What Resend charges

Resend sells transactional mail on its own, with its own dashboard, logs and deliverability tooling. The plans are volume tiers:

- Free: {{ usd vendor.resend.free }} {{ text vendor.resend.free.unit }}, with {{ text vendor.resend.free.includes }}. The daily cap matters more than the monthly one: a daily digest to 400 people fits the month and breaks the day.
- Pro: {{ usd vendor.resend.pro }} {{ text vendor.resend.pro.unit }}, with {{ text vendor.resend.pro.includes }}.
- Scale: {{ usd vendor.resend.scale }} {{ text vendor.resend.scale.unit }}, with {{ text vendor.resend.scale.includes }}.
- Beyond the plan: {{ usd vendor.resend.overageThousand }} {{ text vendor.resend.overageThousand.unit }}.
- Extra domains: {{ usd vendor.resend.domainsAddon }} {{ text vendor.resend.domainsAddon.unit }}.

The plan is per account, not per app, so one subscription covers every project you send from. That is the part worth keeping in mind when you compare: you are weighing one fixed fee against usage across all of your projects, not against a fee per project. {{ checked resend }}

## What ohmyho.st charges for mail

Mail here is a capability of the project, not a separate customer Resend account. It needs Paid: {{ usd plan.paidUsd }} a month buys {{ number plan.paidCredits }} credits that every project shares. Sending and receiving have separate usage meters.

The first is the send itself: {{ rate mail.sent }}. The meter counts **recipients**, not messages. One message to a customer with two people in CC is three recipients. A message to 400 subscribers is 400.

Receiving costs {{ rate mail.received }} per received message. A verified customer domain has no monthly mail-domain meter. The agent can publish the required DKIM, SPF and MX records when you authorize Cloudflare DNS, or show you the exact records to add elsewhere.

Everything else about a project stays on the same balance: hosting, Postgres, a linked domain. There is no second subscription and no per-project mail fee.

## Break-even by volume

The table prices a month of mail from your own sender domain on ohmyho.st against the cheapest Resend plan that covers the same volume. Credit values use the standard rate where {{ number 100 }} credits are {{ usd 1 }}.

| Recipients a month | On ohmyho.st | Cheapest direct Resend plan |
| --- | ---: | --- |
| 2,000 | {{ credits workload.senderTwoThousand }} ({{ usdValue workload.senderTwoThousand }}) | Free, {{ usd vendor.resend.free }} |
| 10,000 | {{ credits workload.senderTenThousand }} ({{ usdValue workload.senderTenThousand }}) | Pro, {{ usd vendor.resend.pro }} |
| 35,000 | {{ credits workload.senderThirtyFiveThousand }} ({{ usdValue workload.senderThirtyFiveThousand }}) | Pro, {{ usd vendor.resend.pro }} |
| 50,000 | {{ credits workload.senderFiftyThousand }} ({{ usdValue workload.senderFiftyThousand }}) | Pro, {{ usd vendor.resend.pro }} |

Under the Free limits, a direct Resend account costs nothing. Around 10,000 recipients, metering is {{ usdValue workload.senderTenThousand }} of credit value against {{ usd vendor.resend.pro }} for direct Pro. Above roughly 11,000 recipients, direct Pro becomes cheaper for sending alone: 50,000 recipients are {{ usdValue workload.senderFiftyThousand }} here against {{ usd vendor.resend.pro }} there. These figures exclude hosting, database use, incoming mail and the Paid subscription. {{ checked resend }}

## What your agent sets up

The agent configures mail through ohmyho.st; you choose the domain and authorize any DNS change.

1. You name one production mail domain for the project; a mail subdomain leaves the company's existing root-domain inbox alone. The Dev and Prod application URLs do not require separate mail domains.
2. ohmyho.st registers that domain under its Resend platform account and returns the required DNS records. With authorized Cloudflare access it publishes those records; otherwise your agent shows what to add.
3. Domain status shows sending and receiving readiness separately. Sending waits for verification. To receive mail, configure a signed project webhook and publish the inbound MX record.
4. Your application sends with its ohmyho.st environment mail credential. ohmyho.st keeps the domain-scoped Resend sending key private.

Sending is bounded the same way everything else is: each accepted recipient reserves credits at claim and settles at provider accept, and a send that the provider refuses is not charged.

## Side by side

{{ figure comparison.resend }}

The left card is a stack bought separately, with Resend Pro as its mail line. The right card is the same work on one balance. For mail alone the comparison is the table above; the reason the whole card still favours one balance at small scale is that hosting and Postgres are on it too, and a quiet project's database suspends while a mail plan does not. {{ checked resend }}

## When Resend is the better choice

Above roughly 11,000 recipients a month, direct Resend Pro is cheaper for sending alone, and the gap widens with volume. It also gives you direct access to Resend's dashboard, logs, suppressions and broadcasts. If you already use Resend, keep your account and store its API key as an application secret; ohmyho.st hosting and Postgres do not require managed mail.

## When ohmyho.st is

When mail is a small, necessary part of an app you already host here. You get one bill to reason about instead of two, the sender domain is set up by the same agent that deploys, and a project that sends a few thousand transactional messages a month lands well under the {{ number plan.paidCredits }} credits the plan already includes. It also fits the freelancer case: every client project can have its own verified sender domain without every client project needing its own subscription.

## FAQ

### Does mail work on the free plan?

No. Managed sending and receiving need Paid and a verified customer domain. Free projects can still use an external provider from server-side application code.

### Are CC and BCC counted separately?

Yes. The meter counts accepted recipients, so one message with a customer in To and two colleagues in CC is three recipients. This matters for digests and notifications that quietly copy a team inbox: the recipient count, not the message count, is what you should estimate.

### Can I keep Resend and still host here?

Yes. Store your own Resend API key as a project secret and call Resend from server-side application code. The ohmyho.st managed-mail meters do not apply to those sends.

### What happens to mail when credits run out?

A zero balance starts a grace period of {{ number plan.graceDays }} days during which funded services keep running, and mail may still send while it lasts. Refilling clears it. After an unresolved grace period only unfunded services are suspended; your data, your exports and your ability to buy credits stay available.

### Is a verified sender domain charged while idle?

No mail-domain usage charge accrues while it is idle. Managed mail still requires the Paid plan; its subscription grants credits shared across your projects.

{{ sources resend }}

[Cost breakdown](/pricing/breakdown) · [ohmyho.st vs Vercel](/vs/vercel) · [Deploy from Claude Code](/for/claude-code) · [What five side projects cost](/blog/what-vercel-supabase-resend-cost-for-five-side-projects)
