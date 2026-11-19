import { readFile } from "node:fs/promises";

/**
 * Keep the public website and Docs on the reviewed customer price contract.
 * @param {string} root
 */
export async function creditPricingTable(root) {
  const contract = await readFile(`${root}/docs/architecture/pricing-contract.md`, "utf8");
  const section = contract.split("## Rate card\n")[1]?.split("### Build price")[0];
  const rows = section
    ?.split("\n")
    .filter((line) => line.startsWith("| `") && !line.startsWith("| `neon."))
    .map((line) => {
      const [meter, quantity, , credits] = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      if (!meter || !quantity || !credits || !/^\d+(?:\.\d{1,6})?$/u.test(credits))
        throw new Error("Invalid customer price table in docs/architecture/pricing-contract.md");
      return `| ${meter} | ${quantity} | ${credits} |`;
    });
  if (!rows?.length)
    throw new Error("Customer price table missing from docs/architecture/pricing-contract.md");
  return ["| Service meter | Measured quantity | Credits |", "| --- | --- | ---: |", ...rows].join(
    "\n",
  );
}

/**
 * Canonical rate rows, including historical providers needed by retained content and accounting.
 * Public consumers select their active meters at the export boundary.
 * @param {string} root
 * @returns {Promise<Record<string, { quantity: number; unit: string; credits: string }>>}
 */
export async function creditPricingRates(root) {
  const contract = await readFile(`${root}/docs/architecture/pricing-contract.md`, "utf8");
  const section = contract.split("## Rate card\n")[1]?.split("### Build price")[0];
  /** @type {Record<string, { quantity: number; unit: string; credits: string }>} */
  const rates = {};
  for (const line of section?.split("\n") ?? []) {
    if (!line.startsWith("| `")) continue;
    const [meter, quantity, , credits] = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const [, amount, unit] = quantity?.match(/^([\d,]+) (.+)$/u) ?? [];
    if (!meter || !amount || !unit || !credits || !/^\d+(?:\.\d{1,6})?$/u.test(credits))
      throw new Error("Invalid customer price table in docs/architecture/pricing-contract.md");
    rates[meter.replaceAll("`", "")] = {
      quantity: Number(amount.replaceAll(",", "")),
      unit,
      credits,
    };
  }
  if (!Object.keys(rates).length)
    throw new Error("Customer price table missing from docs/architecture/pricing-contract.md");
  return rates;
}
