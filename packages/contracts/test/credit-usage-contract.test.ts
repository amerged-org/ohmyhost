import { describe, expect, it } from "vitest";

import { assertOrganizationAccount, assertOrganizationCreditUsage } from "../src/credit-pricing.js";

const ORGANIZATION = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROJECT_A = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
const PROJECT_B = "01ARZ3NDEKTSV4RRFFQ69G5FAB";
const ENVIRONMENT = "01ARZ3NDEKTSV4RRFFQ69G5FAE";

const meter = (overrides: Record<string, unknown> = {}) => ({
  environment_id: ENVIRONMENT,
  meter: "wfp.requests",
  unit: "request",
  rate_card_id: "usage-2026-10-v1",
  quantity: "1500.25",
  charged_micros: "180",
  ...overrides,
});
const usage = (overrides: Record<string, unknown> = {}) => ({
  organization_id: ORGANIZATION,
  as_of: "2026-10-30T10:00:00.000Z",
  unit: "microcredits",
  period: "2026-10",
  from: "2026-10-17T00:00:00.000Z",
  projects: [
    { project_id: PROJECT_A, used_micros: "180" },
    { project_id: PROJECT_B, used_micros: "0" },
  ],
  days: [
    { day: "2026-10-29", projects: [{ project_id: PROJECT_A, meters: [meter()] }] },
    {
      day: "2026-10-30",
      projects: [
        { project_id: PROJECT_A, meters: [meter({ environment_id: null })] },
        { project_id: PROJECT_B, meters: [] },
      ],
    },
  ],
  ...overrides,
});

describe("the organization credit usage report", () => {
  it("accepts days of projects and meters with exact decimal quantities and a shared project cost", () => {
    expect(() => assertOrganizationCreditUsage(usage())).not.toThrow();
    expect(() => assertOrganizationCreditUsage(usage({ projects: [], days: [] }))).not.toThrow();
    expect(() =>
      assertOrganizationCreditUsage(
        usage({
          days: [
            {
              day: "2026-10-29",
              projects: [
                {
                  project_id: PROJECT_A,
                  meters: [
                    meter({
                      meter: "browser.duration",
                      unit: "millisecond",
                      quantity: "1.12345678901234567890",
                    }),
                  ],
                },
              ],
            },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it.each<[string, Record<string, unknown>]>([
    ["a field of the old monthly report", { month: "2026-10", next_cursor: null }],
    ["a period that is not a month", { period: "2026-13" }],
    ["a time that is not canonical", { as_of: "2026-10-30T10:00:00Z" }],
    ["a unit that is not microcredits", { unit: "credits" }],
    ["projects that are not in ID order", { projects: usage().projects.slice().reverse() }],
    [
      "a project without a valid amount",
      { projects: [{ project_id: PROJECT_A, used_micros: "-1" }] },
    ],
    [
      "a project with another field",
      { projects: [{ project_id: PROJECT_A, used_micros: "1", x: 1 }] },
    ],
    ["days that are not in order", { days: usage().days.slice().reverse() }],
    ["a day that is not a date", { days: [{ day: "2026-10-3", projects: [] }] }],
    [
      "more days than the log keeps",
      {
        days: Array.from({ length: 16 }, (_, i) => ({
          day: `2026-10-${String(i + 10)}`,
          projects: [],
        })),
      },
    ],
    [
      "projects within a day that are not in ID order",
      {
        days: [
          {
            day: "2026-10-29",
            projects: [
              { project_id: PROJECT_B, meters: [] },
              { project_id: PROJECT_A, meters: [] },
            ],
          },
        ],
      },
    ],
    [
      "a meter with a charge that is not an amount",
      {
        days: [
          {
            day: "2026-10-29",
            projects: [{ project_id: PROJECT_A, meters: [meter({ charged_micros: "1.5" })] }],
          },
        ],
      },
    ],
    [
      "a quantity with too many decimals",
      {
        days: [
          {
            day: "2026-10-29",
            projects: [
              {
                project_id: PROJECT_A,
                meters: [meter({ quantity: "1.123456789012345678901" })],
              },
            ],
          },
        ],
      },
    ],
    [
      "a meter name with a space",
      {
        days: [
          {
            day: "2026-10-29",
            projects: [{ project_id: PROJECT_A, meters: [meter({ meter: "wfp requests" })] }],
          },
        ],
      },
    ],
    [
      "an environment that is not an ID",
      {
        days: [
          {
            day: "2026-10-29",
            projects: [{ project_id: PROJECT_A, meters: [meter({ environment_id: "dev" })] }],
          },
        ],
      },
    ],
    [
      "a meter with the removed funding split",
      {
        days: [
          {
            day: "2026-10-29",
            projects: [{ project_id: PROJECT_A, meters: [meter({ funded_micros: "180" })] }],
          },
        ],
      },
    ],
  ])("refuses %s", (_name, overrides) => {
    expect(() => assertOrganizationCreditUsage(usage(overrides))).toThrow(TypeError);
  });

  it("refuses a report that is not an object", () => {
    for (const value of [null, [], "report", 1])
      expect(() => assertOrganizationCreditUsage(value)).toThrow(TypeError);
  });
});

describe("the organization account", () => {
  const account = (overrides: Record<string, unknown> = {}) => ({
    organization_id: ORGANIZATION,
    name: "Workspace",
    workos_organization_id: "org_01",
    plan: "free",
    plan_source: "free",
    paid_until: null,
    available_micros: "196000000",
    monthly_micros: "190000000",
    one_time_micros: "10000000",
    reserved_micros: "4000000",
    next_expiry: "2026-11-01T00:00:00.000Z",
    as_of: "2026-10-30T10:00:00.000Z",
    ...overrides,
  });

  it("takes available as monthly plus one-time credit minus the reservations, never below zero", () => {
    expect(() => assertOrganizationAccount(account())).not.toThrow();
    expect(() =>
      assertOrganizationAccount(
        account({
          available_micros: "0",
          monthly_micros: "1",
          one_time_micros: "0",
          reserved_micros: "5",
        }),
      ),
    ).not.toThrow();
    expect(() => assertOrganizationAccount(account({ available_micros: "200000000" }))).toThrow(
      "Account credit buckets do not balance",
    );
    expect(() => assertOrganizationAccount(account({ available_micros: "190000000" }))).toThrow(
      "Account credit buckets do not balance",
    );
  });
});
