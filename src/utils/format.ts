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
const oneDecimal = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
// A download's size: whole megabytes, gigabytes from 1 GB on with one decimal.
export const formatBytes = (bytes: number) => bytes < 1e9 ? `${formatWhole(Math.max(1, bytes / 1e6))} MB` : `${oneDecimal.format(bytes / 1e9)} GB`;
const dayFormat = { day: '2-digit', month: '2-digit', year: 'numeric' } as const;
export const formatDate = (date: string | number) => new Date(date).toLocaleDateString('de-AT', dayFormat);
export const formatDateTime = (date: string | number) => new Date(date).toLocaleString('de-AT', { ...dayFormat, hour: '2-digit', minute: '2-digit' });
