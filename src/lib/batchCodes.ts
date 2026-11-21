// A batch is a named group of units added to an item at once, such as the bunches of one harvest.
// Its code is the organization's prefix, the date as MMDDYY, the first two letters of the item and
// a number, so Stargazer Farm's Latundan banana added on Nov 21, 2026 is SF112126LA01.

// Letters and digits, capitals, at most six.
export const normalizeBatchPrefix = (value: string): string =>
  value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6);

// The first two letters of the item's name, in capitals.
export const itemLetters = (name: string): string =>
  name.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 2);

// The date as MMDDYY, the day it is on the farm (Asia/Manila).
export function codeDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: '2-digit', month: '2-digit', day: '2-digit' })
    .formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('month')}${get('day')}${get('year')}`;
}

// The next code for the item on the day: the prefix, date and letters, and a two digit number one
// above the largest already used with that start. Without a prefix the code starts with the date.
export function nextBatchCode(prefix: string | undefined, itemName: string, date: Date, existing: string[]): string {
  const cleaned = normalizeBatchPrefix(prefix ?? '');
  const start = `${cleaned}${codeDate(date)}${itemLetters(itemName)}`;
  const used = existing
    .filter((code) => code.startsWith(start))
    .map((code) => Number(code.slice(start.length)))
    .filter((n) => Number.isInteger(n) && n > 0);
  return `${start}${String(Math.max(0, ...used) + 1).padStart(2, '0')}`;
}
