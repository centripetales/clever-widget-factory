import { describe, it, expect } from 'vitest';
import { codeDate, itemLetters, nextBatchCode, normalizeBatchPrefix } from '@/lib/batchCodes';

describe('batch codes', () => {
  it('takes the first two letters of the item name, in capitals', () => {
    expect(itemLetters('Latundan banana')).toBe('LA');
    expect(itemLetters('  3 egg, medium')).toBe('EG');
    expect(itemLetters('X')).toBe('X');
  });

  it('writes the date as MMDDYY on the farm day', () => {
    expect(codeDate(new Date('2026-11-21T06:00:00Z'))).toBe('112126');
    // 20:00 UTC is already the next day in Manila
    expect(codeDate(new Date('2026-11-21T20:00:00Z'))).toBe('112226');
  });

  it('cleans a prefix to capital letters and digits, at most six', () => {
    expect(normalizeBatchPrefix(' s-f ')).toBe('SF');
    expect(normalizeBatchPrefix('abcdefghij')).toBe('ABCDEF');
  });

  it('fills in the code as prefix, date, letters and number, starting at 01', () => {
    expect(nextBatchCode('SF', 'Latundan banana', new Date('2026-11-21T06:00:00Z'), [])).toBe('SF112126LA01');
  });

  it('counts on from the codes already used that day for the same start', () => {
    const existing = ['SF112126LA01', 'SF112126LA02', 'SF112026LA09', 'SF112126EG01'];
    expect(nextBatchCode('SF', 'Latundan banana', new Date('2026-11-21T06:00:00Z'), existing)).toBe('SF112126LA03');
  });

  it('starts with the date when there is no prefix, so a code is still filled in', () => {
    const date = new Date('2026-11-21T06:00:00Z');
    expect(nextBatchCode(undefined, 'Latundan banana', date, [])).toBe('112126LA01');
    expect(nextBatchCode('', 'Latundan banana', date, ['112126LA01'])).toBe('112126LA02');
  });
});
