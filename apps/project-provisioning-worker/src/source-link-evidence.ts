/** Same original narrow extraction: provider validation happened in observeLink, no arbitrary terminal JSON is sent. */
export function sourceLinkEvidence(value: Readonly<Record<string, unknown>>): {
  externalRepositoryId: string;
} {
  if (typeof value["externalRepositoryId"] !== "string")
    throw new TypeError("Repository link evidence is invalid");
  return { externalRepositoryId: value["externalRepositoryId"] };
}
