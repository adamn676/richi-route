// German number formats (dot thousands, comma decimals). Formatters are kept, since creating one is costly.
const kilometres: Record<string, Intl.NumberFormat> = {};
const wholeNumber = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });

// Up to `digits` decimals; `fixed` always shows all of them.
export function formatKm(meters: number, digits = 2, fixed = false): string {
  const format = kilometres[`${digits}${fixed}`] ??= new Intl.NumberFormat('de-DE',
    { maximumFractionDigits: digits, minimumFractionDigits: fixed ? digits : 0 });
  return format.format(meters / 1000);
}
export const formatMeters = (meters: number) => `${wholeNumber.format(meters)} m`;
