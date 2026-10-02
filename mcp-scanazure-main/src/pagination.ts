import { createHash } from "node:crypto";
import { z } from "zod";

const tokenSchema = z.object({
  offset: z.number().int().nonnegative(),
  fingerprint: z.string().length(16)
});

export function pageSlice<T>(
  values: T[],
  pageSize: number,
  pageToken: string | undefined,
  filters: unknown
): {
  values: T[];
  nextPageToken: string | null;
  total: number;
} {
  const fingerprint = filterFingerprint(filters);
  const offset = pageToken ? decodePageToken(pageToken, fingerprint) : 0;
  if (offset > values.length) {
    throw new Error("Page token points beyond the available results");
  }
  const page = values.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length;
  return {
    values: page,
    nextPageToken:
      nextOffset < values.length
        ? Buffer.from(
            JSON.stringify({ offset: nextOffset, fingerprint }),
            "utf8"
          ).toString("base64url")
        : null,
    total: values.length
  };
}

function decodePageToken(token: string, expectedFingerprint: string): number {
  try {
    const parsed = tokenSchema.parse(
      JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as unknown
    );
    if (parsed.fingerprint !== expectedFingerprint) {
      throw new Error("Page token does not match the current filters");
    }
    return parsed.offset;
  } catch (error) {
    if (error instanceof Error && error.message.includes("current filters")) {
      throw error;
    }
    throw new Error("Invalid page token");
  }
}

function filterFingerprint(filters: unknown): string {
  return createHash("sha256")
    .update(stableStringify(filters))
    .digest("hex")
    .slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
