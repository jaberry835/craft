const imageExtensions = new Set(['.bmp', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.tif', '.tiff', '.webp']);

export function resolveUploadDestination(fileName: string, selectedDestination: string): string {
  if (selectedDestination) return selectedDestination;
  const dotIndex = fileName.lastIndexOf('.');
  const extension = dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : '';
  return imageExtensions.has(extension) ? 'evidence/screenshots' : '';
}
