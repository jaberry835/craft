import { wildcardMediaTypeMatch } from '../wildcardMediaTypeMatch';

describe('wildcardMediaTypeMatch', () => {
  describe('matches', () => {
    it('exactly the same content types', () => {
      expect(wildcardMediaTypeMatch('application/json', 'application/json')).toBe(true);
    });

    it.each([
      ['application/vnd1+json', 'application/json'],
      ['application/vnd1+json', 'application/vnd-2+json'],
    ])('with difference in suffix: %s - %s', (a, b) => {
      expect(wildcardMediaTypeMatch(a, b)).toBe(true);
    });

    it.each([
      ['application/json; p1=1', 'application/json'],
      ['application/json; p1=1', 'application/json; p1=2'],
      ['application/vnd1+json; p1=1', 'application/json; p1=2'],
      ['application/json', 'application/json; p1=2'],
    ])('ignores parameters: %s - %s', (a, b) => {
      expect(wildcardMediaTypeMatch(a, b)).toBe(true);
    });

    it.each([
      ['text/html', '*/html'],
      ['text/html', 'text/*'],
      ['text/html', '*/*'],
      ['application/x-custom+json', '*/*+json'],
    ])('with wildcards: %s - %s', (a, b) => {
      expect(wildcardMediaTypeMatch(a, b)).toBe(true);
    });
  });

  describe('does not match', () => {
    it('with difference in type', () => {
      expect(wildcardMediaTypeMatch('application/json', 'image/json')).toBe(false);
    });

    it('with difference in subtype', () => {
      expect(wildcardMediaTypeMatch('application/json', 'application/csv')).toBe(false);
    });

    it('if one of media type is invalid', () => {
      expect(wildcardMediaTypeMatch('invalid', 'application/csv')).toBe(false);
      expect(wildcardMediaTypeMatch('application/csv', 'invalid')).toBe(false);
    });
  });
});
