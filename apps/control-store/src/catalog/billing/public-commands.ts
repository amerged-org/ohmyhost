import type { CatalogContext } from "../common.js";
import {
  readCreditAccount,
  readCreditOrganization,
  readProjectCreditBudgetPublic,
} from "./public-reads.js";
import { readCreditUsage } from "./public-usage.js";
import { configureProjectCreditBudget } from "./public-budget.js";

export type BindPublicCreditCommand = <Result>(
  command: (context: CatalogContext, input: unknown) => Promise<Result>,
) => (input: unknown) => Promise<Result>;

/** The five customer-facing credit reads and the budget command; they are the whole of `PublicCreditRuntime`. */
export function createPublicCreditCommands(bind: BindPublicCreditCommand) {
  return Object.freeze({
    readCreditAccount: bind(readCreditAccount),
    readCreditOrganization: bind(readCreditOrganization),
    readCreditUsage: bind(readCreditUsage),
    readProjectCreditBudgetPublic: bind(readProjectCreditBudgetPublic),
    configureProjectCreditBudget: bind(configureProjectCreditBudget),
  });
}
