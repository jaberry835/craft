export const NIST_STANDARD = "NIST SP 800-53 Rev. 5";

export const NIST_FAMILY_NAMES: Record<string, string> = {
  AC: "Access Control",
  AT: "Awareness and Training",
  AU: "Audit and Accountability",
  CA: "Assessment, Authorization, and Monitoring",
  CM: "Configuration Management",
  CP: "Contingency Planning",
  IA: "Identification and Authentication",
  IR: "Incident Response",
  MA: "Maintenance",
  MP: "Media Protection",
  PE: "Physical and Environmental Protection",
  PL: "Planning",
  PM: "Program Management",
  PS: "Personnel Security",
  PT: "Personally Identifiable Information Processing and Transparency",
  RA: "Risk Assessment",
  SA: "System and Services Acquisition",
  SC: "System and Communications Protection",
  SI: "System and Information Integrity",
  SR: "Supply Chain Risk Management"
};

export function normalizeControlId(value: string): string | null {
  const decoded = safeDecode(value).toUpperCase().replace(/_/g, "-");
  const match = decoded.match(/(?:^|[^A-Z])(AC|AT|AU|CA|CM|CP|IA|IR|MA|MP|PE|PL|PM|PS|PT|RA|SA|SC|SI|SR)-(\d+)(?:[.( -]*(\d+)[)]?)?/);
  if (!match?.[1] || !match[2]) return null;
  return `${match[1]}-${Number(match[2])}${match[3] ? `(${Number(match[3])})` : ""}`;
}

export function controlFamily(controlId: string): string {
  return controlId.split("-", 1)[0] ?? "Unknown";
}

export function familyName(family: string): string {
  return NIST_FAMILY_NAMES[family] ?? family;
}

export function matchesConfiguredNist(
  values: Array<string | null | undefined>,
  initiativeIds: ReadonlySet<string>,
  namePatterns: string[]
): boolean {
  const candidates = values.filter((value): value is string => Boolean(value));
  for (const value of candidates) {
    const lowered = value.toLowerCase();
    const terminal = lowered.split("/").filter(Boolean).pop() ?? lowered;
    if (initiativeIds.has(lowered) || initiativeIds.has(terminal)) return true;
  }
  const normalizedCandidates = candidates.map(normalizeName);
  return namePatterns.some((pattern) => {
    const wanted = normalizeName(pattern);
    return wanted.length > 0 && normalizedCandidates.some((candidate) => candidate.includes(wanted));
  });
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
