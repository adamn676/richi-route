// utils/placeicons.ts

/**
 * getIconForPlaceType
 *
 * Translates place.kind (like "address", "street", "poi", "peak", etc.)
 * into one of your available icons. Adjust as needed.
 */
export function getIconForPlaceType(placeKind: string): string {
  // Normalize to lowercase just in case
  const kind = placeKind.toLowerCase();

  // Switch or if/else approach
  if (kind === "address") {
    return "location_on";
  }
  if (kind === "street" || kind === "road") {
    return "pin_drop";
  }
  if (kind === "poi") {
    return "poi"; // literally the "poi" icon
  }
  if (kind === "peak") {
    return "adjust_pin"; // or "pin_home"
  }
  if (kind === "place" || kind === "neighbourhood") {
    return "location_pin";
  }
  if (kind === "region" || kind === "admin_area") {
    return "radio_button_unchecked";
  }

  // Fallback
  return "pin";
}
