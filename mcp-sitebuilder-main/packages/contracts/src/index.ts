import { posix } from 'node:path';
import { z } from 'zod';

export const limits = {
  maxDocuments: 200,
  maxDocumentBytes: 1_000_000,
  maxTotalBytes: 20_000_000,
  maxPathLength: 240,
} as const;

export const ThemeIdSchema = z.enum(['clarity', 'slate', 'paper']);
export type ThemeId = z.infer<typeof ThemeIdSchema>;

export const ClassificationSchema = z.enum([
  'UNCLASSIFIED',
  'CUI',
  'CONFIDENTIAL',
  'SECRET',
  'TOP_SECRET',
]);
export type Classification = z.infer<typeof ClassificationSchema>;

const invalidPathSegment = /(^|\/)(\.{1,2})(\/|$)|[<>:"|?*\\]/u;

export function normalizeDocumentPath(value: string): string {
  const candidate = value.trim().replaceAll('\\', '/');
  if (
    candidate.length === 0 ||
    candidate.length > limits.maxPathLength ||
    candidate.startsWith('/') ||
    /^[a-z]:/iu.test(candidate) ||
    invalidPathSegment.test(candidate) ||
    [...candidate].some((character) => character.charCodeAt(0) <= 31)
  ) {
    throw new Error(`Unsafe document path: ${value}`);
  }

  const normalized = posix.normalize(candidate).replace(/^\.\//u, '');
  if (normalized.startsWith('../') || !/\.(?:md|txt)$/iu.test(normalized)) {
    throw new Error(`Document path must be a safe relative .md or .txt path: ${value}`);
  }
  return normalized;
}

export const DocumentPathSchema = z
  .string()
  .min(1)
  .max(limits.maxPathLength)
  .refine(
    (value) => {
      try {
        normalizeDocumentPath(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Path must be a safe relative .md or .txt path.' },
  )
  .transform((value) => {
    try {
      return normalizeDocumentPath(value);
    } catch {
      return value;
    }
  })
  .describe('Safe relative .md or .txt path; folders are created implicitly.');

export const SourceDocumentSchema = z.object({
  path: DocumentPathSchema,
  content: z.string().max(limits.maxDocumentBytes).describe('UTF-8 Markdown or plain text.'),
});
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;

export const SiteIdSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u)
  .describe('Stable lowercase site ID using letters, digits, and hyphens.');

const siteMetadataShape = {
  siteId: SiteIdSchema,
  displayName: z.string().trim().min(1).max(100).describe('Human-readable site title.'),
  description: z.string().trim().max(500).optional().describe('Optional catalog summary.'),
  themeId: ThemeIdSchema.default('clarity').describe('Preset visual theme; defaults to clarity.'),
  classification: ClassificationSchema.default('UNCLASSIFIED').describe(
    'Classification bar shown on every page; defaults to UNCLASSIFIED.',
  ),
} as const;

export const SiteManifestSchema = z
  .object({
    ...siteMetadataShape,
    documents: z
      .array(SourceDocumentSchema)
      .min(1)
      .max(limits.maxDocuments)
      .describe('Markdown and plain-text documents to publish.'),
  })
  .superRefine((site, context) => {
    const paths = new Set<string>();
    const outputPaths = new Set<string>();
    let totalBytes = 0;
    for (const [index, document] of site.documents.entries()) {
      const folded = document.path.toLocaleLowerCase('en-US');
      if (paths.has(folded)) {
        context.addIssue({
          code: 'custom',
          path: ['documents', index, 'path'],
          message: 'Document paths must be unique when compared case-insensitively.',
        });
      }
      paths.add(folded);
      const outputPath = folded.replace(/\.(?:md|txt)$/u, '.html');
      if (outputPaths.has(outputPath)) {
        context.addIssue({
          code: 'custom',
          path: ['documents', index, 'path'],
          message: 'Document paths must produce unique HTML paths.',
        });
      }
      outputPaths.add(outputPath);
      totalBytes += Buffer.byteLength(document.content, 'utf8');
    }
    if (totalBytes > limits.maxTotalBytes) {
      context.addIssue({
        code: 'custom',
        path: ['documents'],
        message: `Combined document content exceeds ${limits.maxTotalBytes} bytes.`,
      });
    }
  });
export type SiteManifest = z.infer<typeof SiteManifestSchema>;
export type SiteManifestInput = z.input<typeof SiteManifestSchema>;

export const CreateSiteDraftSchema = z.object(siteMetadataShape);
export type CreateSiteDraftInput = z.input<typeof CreateSiteDraftSchema>;

export const UpsertSiteFilesSchema = z.object({
  siteId: SiteIdSchema,
  files: z
    .array(SourceDocumentSchema)
    .min(1)
    .max(limits.maxDocuments)
    .describe('One or more files to add or replace; path folders are implicit.'),
});
export type UpsertSiteFilesInput = z.input<typeof UpsertSiteFilesSchema>;

export const SiteDraftSchema = z.object({
  ...siteMetadataShape,
  documents: z.array(SourceDocumentSchema).max(limits.maxDocuments),
  revision: z.int().nonnegative(),
  updatedAt: z.iso.datetime(),
});
export type SiteDraft = z.infer<typeof SiteDraftSchema>;

export const SiteDraftSummarySchema = z.object({
  ...siteMetadataShape,
  revision: z.int().nonnegative(),
  updatedAt: z.iso.datetime(),
  fileCount: z.int().nonnegative(),
  totalBytes: z.int().nonnegative(),
  files: z.array(DocumentPathSchema),
});
export type SiteDraftSummary = z.infer<typeof SiteDraftSummarySchema>;

export const OperationStatusSchema = z.enum([
  'queued',
  'building',
  'publishing',
  'succeeded',
  'failed',
]);
export type OperationStatus = z.infer<typeof OperationStatusSchema>;

export const PublishOperationSchema = z.object({
  operationId: z.uuid(),
  siteId: z.string(),
  status: OperationStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  version: z.string().optional(),
  siteUrl: z.url().optional(),
  error: z.string().optional(),
});
export type PublishOperation = z.infer<typeof PublishOperationSchema>;

export const SiteCatalogEntrySchema = z.object({
  siteId: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  classification: ClassificationSchema,
  themeId: ThemeIdSchema,
  version: z.string(),
  url: z.string(),
  updatedAt: z.iso.datetime(),
});
export type SiteCatalogEntry = z.infer<typeof SiteCatalogEntrySchema>;

export interface GeneratedFile {
  path: string;
  content: string;
  contentType: 'text/html; charset=utf-8' | 'text/css; charset=utf-8' | 'application/json';
  cacheControl: string;
}

export interface GeneratedSite {
  siteId: string;
  version: string;
  files: GeneratedFile[];
  entryPath: string;
}

export interface MenuNode {
  kind: 'folder' | 'page';
  name: string;
  path?: string;
  children?: MenuNode[];
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  requestId?: string;
  errors?: unknown;
}
