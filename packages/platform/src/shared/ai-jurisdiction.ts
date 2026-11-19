/**
 * Whether orq's authoritative location metadata permits a model in an EU-only project. A provider name or a token in
 * the model id is not placement evidence; an empty, mixed, global or non-EU location list never qualifies.
 */
export function isEuOnlyLocations(locations: readonly string[]): boolean {
  return locations.length > 0 && locations.every((location) => location === "eu");
}
