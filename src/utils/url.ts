// A URL of the planner's own server made absolute, as MapLibre wants; its {z}/{x}/{y} placeholders stay as they are.
export const absoluteUrl = (url: string) => url.startsWith('/') ? location.origin + url : url;
