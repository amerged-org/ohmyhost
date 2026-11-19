/** Original browser headers survive the local framework proxy and are never authority. */
export const ORIGINAL_BROWSER_HEADERS = Object.freeze([
  ["origin", "x-ohmyhost-preview-original-origin"],
  ["referer", "x-ohmyhost-preview-original-referer"],
]);
