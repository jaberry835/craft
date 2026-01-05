import { Dictionary } from '@stoplight/types';

export function serializeWithDeepObjectStyle(name: string, value: string | string[] | Dictionary<unknown> | null) {
  return serialize(name, [], value);
}

function serialize(name: string, path: string[], value: string | string[] | Dictionary<unknown> | null): string | null {
  if (value === null) {
    return null;
  } else if (typeof value === 'object') {
    const result = Object.keys(value)
      .map(key => serialize(name, [...path, isPositiveInteger(key) ? '' : key], value[key]))
      .filter(key => key !== null)
      .join('&');

    return result.length > 0 ? result : null;
  } else {
    return `${name}${path.map(key => `[${key}]`).join('')}=${value}`;
  }
}

function isPositiveInteger(str: string) {
  return /^\+?\d+$/.test(str) && parseInt(str) >= 0;
}
