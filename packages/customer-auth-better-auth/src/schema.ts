import { CUSTOMER_AUTH_INSTALLATION_CONTRACT } from "./installation-contract.js";

const EXPECTED_TABLES = CUSTOMER_AUTH_INSTALLATION_CONTRACT.database.tables;

export function renderCustomerAuthMigration(generatedSchema: string): string {
  if (
    typeof generatedSchema !== "string" ||
    generatedSchema.length < 1 ||
    generatedSchema.length > 256 * 1024 ||
    generatedSchema.includes("\r") ||
    /^(?:drop|alter|truncate|delete|update|insert)\b/imu.test(generatedSchema)
  ) {
    throw new TypeError("Generated Better Auth schema is invalid");
  }
  const tables = [...generatedSchema.matchAll(/^create table "([^"]+)"/gmu)]
    .map((match) => match[1])
    .sort();
  if (JSON.stringify(tables) !== JSON.stringify(EXPECTED_TABLES)) {
    throw new TypeError("Generated Better Auth schema is invalid");
  }
  const qualified = generatedSchema
    .replace(/^create table "([^"]+)"/gmu, 'create table auth."$1"')
    .replace(/ references "([^"]+)"/gu, ' references auth."$1"')
    .replace(/^(create (?:unique )?index "[^"]+" on) "([^"]+)"/gmu, '$1 auth."$2"');
  if (/^create table "| references "| on "/mu.test(qualified)) {
    throw new TypeError("Generated Better Auth schema is invalid");
  }
  return `create schema if not exists auth;\n\n${qualified.trimEnd()}\n`;
}
