import { z } from "zod";

export const accessSchema = z.object({
  status: z.enum(["full", "partial", "denied", "unavailable"]),
  notes: z.array(z.string())
});

export const errorSchema = z.object({
  source: z.string(),
  code: z.string(),
  message: z.string()
});

export const callerSchema = z.object({
  authMode: z.enum(["none", "obo", "arm-token"]),
  upn: z.string().optional(),
  oid: z.string().optional()
});

export interface EnvelopeOptions<TSummary, TData> {
  tool: string;
  tenantId: string | null;
  authMode: "none" | "obo" | "arm-token";
  scope: {
    level: "tenant" | "subscription" | "resourceGroup" | "resource";
    subscriptionId?: string;
    resourceId?: string;
  };
  summary: TSummary;
  data: TData;
  page?: {
    nextPageToken: string | null;
    returned: number;
    total: number | null;
  };
  portalLinks?: Record<string, string>;
  accessStatus?: "full" | "partial" | "denied" | "unavailable";
  accessNotes?: string[];
  errors?: Array<z.infer<typeof errorSchema>>;
}

export function createEnvelope<TSummary, TData>(options: EnvelopeOptions<TSummary, TData>) {
  return {
    tool: options.tool,
    generatedAt: new Date().toISOString(),
    tenantId: options.tenantId,
    scope: options.scope,
    caller: { authMode: options.authMode },
    access: {
      status:
        options.accessStatus ??
        (options.errors?.length ? ("partial" as const) : ("full" as const)),
      notes: options.accessNotes ?? []
    },
    summary: options.summary,
    data: options.data,
    page: options.page ?? null,
    portalLinks: options.portalLinks ?? {},
    errors: options.errors ?? []
  };
}
