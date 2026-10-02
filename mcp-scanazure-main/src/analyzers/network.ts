export type NetworkSeverity = "low" | "medium" | "high";

export interface NetworkFinding {
  checkId: string;
  title: string;
  severity: NetworkSeverity;
  resourceId: string;
  evidence: Record<string, unknown>;
  nistControls: string[];
}

export interface NsgRule {
  name: string;
  direction?: string;
  access?: string;
  priority?: number;
  protocol?: string;
  sourceAddressPrefix?: string;
  sourceAddressPrefixes?: string[];
  destinationAddressPrefix?: string;
  destinationAddressPrefixes?: string[];
  destinationPortRange?: string;
  destinationPortRanges?: string[];
}

const MANAGEMENT_PORTS = new Map<number, string>([
  [22, "SSH"],
  [3389, "RDP"],
  [5985, "WinRM HTTP"],
  [5986, "WinRM HTTPS"],
  [1433, "SQL Server"],
  [3306, "MySQL"],
  [5432, "PostgreSQL"],
  [6379, "Redis"],
  [27017, "MongoDB"]
]);

export function analyzeNsgRules(
  networkSecurityGroupId: string,
  rules: NsgRule[]
): NetworkFinding[] {
  const findings: NetworkFinding[] = [];

  for (const rule of rules) {
    if (
      !equalsIgnoreCase(rule.direction, "Inbound") ||
      !equalsIgnoreCase(rule.access, "Allow")
    ) {
      continue;
    }

    const sources = compact([
      rule.sourceAddressPrefix,
      ...(rule.sourceAddressPrefixes ?? [])
    ]);
    if (!sources.some(isInternetSource)) {
      continue;
    }

    const portRanges = compact([
      rule.destinationPortRange,
      ...(rule.destinationPortRanges ?? [])
    ]);
    if (portRanges.some(isAnyPort)) {
      findings.push({
        checkId: "network.nsg.internet-allow-all",
        title: "NSG allows inbound internet traffic to all destination ports",
        severity: "high",
        resourceId: networkSecurityGroupId,
        evidence: ruleEvidence(rule, sources, portRanges),
        nistControls: ["AC-4", "SC-7"]
      });
      continue;
    }

    const exposed = [...MANAGEMENT_PORTS.entries()]
      .filter(([port]) => portRanges.some((range) => rangeIncludesPort(range, port)))
      .map(([port, service]) => ({ port, service }));
    if (exposed.length > 0) {
      findings.push({
        checkId: "network.nsg.management-port-from-internet",
        title: "NSG exposes management or data-service ports to the internet",
        severity: "high",
        resourceId: networkSecurityGroupId,
        evidence: {
          ...ruleEvidence(rule, sources, portRanges),
          exposedPorts: exposed
        },
        nistControls: ["AC-17", "CM-7", "SC-7"]
      });
    }
  }

  return findings;
}

function ruleEvidence(
  rule: NsgRule,
  sources: string[],
  portRanges: string[]
): Record<string, unknown> {
  return {
    ruleName: rule.name,
    priority: rule.priority ?? null,
    protocol: rule.protocol ?? "*",
    sourceAddressPrefixes: sources,
    destinationPortRanges: portRanges
  };
}

function isInternetSource(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "*" ||
    normalized === "internet" ||
    normalized === "0.0.0.0/0" ||
    normalized === "::/0" ||
    normalized === "any"
  );
}

function isAnyPort(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "*" || normalized === "0-65535" || normalized === "any";
}

function rangeIncludesPort(value: string, port: number): boolean {
  const normalized = value.trim();
  if (isAnyPort(normalized)) {
    return true;
  }
  if (/^\d+$/.test(normalized)) {
    return Number(normalized) === port;
  }
  const match = normalized.match(/^(\d+)-(\d+)$/);
  return Boolean(match && Number(match[1]) <= port && port <= Number(match[2]));
}

function equalsIgnoreCase(left: string | undefined, right: string): boolean {
  return left?.toLowerCase() === right.toLowerCase();
}

function compact(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value));
}
