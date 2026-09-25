export function evidenceCapturePath(href: string, capturedAt = new Date()): string | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return undefined;
  const page = url.pathname.split('/').filter(Boolean).at(-1) ?? 'page';
  const stem = `${url.hostname}-${page}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100) || 'web-page';
  const timestamp = capturedAt.toISOString().replace(/[:.]/g, '-');
  return `evidence/screenshots/${stem}-${timestamp}.png`;
}
