import { createObjectFromKeyValList } from '../utils';

describe('createObjectFromKeyValList()', () => {
  it('works', () => {
    expect(createObjectFromKeyValList(['a', 'b', 'c', 'd'])).toEqual({ a: 'b', c: 'd' });
  });
});
