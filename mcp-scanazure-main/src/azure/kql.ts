export function escapeKqlString(value: string): string {
  return value.replace(/'/g, "''");
}

export function kqlString(value: string): string {
  return `'${escapeKqlString(value)}'`;
}
