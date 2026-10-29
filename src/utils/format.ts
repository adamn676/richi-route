// German number formats (dot thousands, comma decimals). Formatters are kept, since creating one is costly.
const kilometres: Record<string, Intl.NumberFormat> = {};
const wholeNumber = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const signedGradient = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1, signDisplay: 'exceptZero' });

// Up to `digits` decimals; `fixed` always shows all of them.
export function formatKm(meters: number, digits = 2, fixed = false): string {
  const format = kilometres[`${digits}${fixed}`] ??= new Intl.NumberFormat('de-DE',
    { maximumFractionDigits: digits, minimumFractionDigits: fixed ? digits : 0 });
  return format.format(meters / 1000);
}
export const formatWhole = (value: number) => wholeNumber.format(value);
export const formatMeters = (meters: number) => `${formatWhole(meters)} m`;
export const formatLength = (meters: number) => meters < 1000 ? `${meters < 1 ? '< 1' : Math.round(meters)} m` : `${formatKm(meters, 1)} km`;
// A gradient in percent, signed: +4,5 or -2.
export const formatGradient = (percent: number) => signedGradient.format(percent);
