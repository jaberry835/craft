import type { CloudProfile } from "./cloud/profile.js";
import type { AppConfig } from "./config.js";

export type PortalLinkTemplates = AppConfig["portalLinkTemplates"];

const DEFAULT_TEMPLATES: PortalLinkTemplates = {
  resource: "/#{tenant}/resource{resourceId}",
  policyCompliance: "/#view/Microsoft_Azure_Policy/PolicyComplianceDetailedBlade/id/{assignmentId}",
  policyOverview: "/#view/Microsoft_Azure_Policy/PolicyMenuBlade/~/Compliance",
  defender: "/#view/Microsoft_Azure_Security/SecurityMenuBlade/~/0",
  defenderRegulatory: "/#view/Microsoft_Azure_Security/SecurityMenuBlade/~/22"
};

export function portalResourceUrl(
  cloud: CloudProfile,
  resourceId: string,
  tenantId?: string,
  templates: PortalLinkTemplates = DEFAULT_TEMPLATES
): string {
  const tenantSegment = tenantId ? `@${encodeURIComponent(tenantId)}` : "";
  return portalUrl(cloud, templates.resource, {
    tenant: tenantSegment,
    resourceId
  });
}

export function portalPolicyUrl(
  cloud: CloudProfile,
  templates: PortalLinkTemplates,
  assignmentId?: string
): string {
  return portalUrl(
    cloud,
    assignmentId ? templates.policyCompliance : templates.policyOverview,
    { assignmentId: assignmentId ? encodeURIComponent(assignmentId) : "" }
  );
}

export function portalDefenderUrl(
  cloud: CloudProfile,
  templates: PortalLinkTemplates,
  regulatory = false
): string {
  return portalUrl(cloud, regulatory ? templates.defenderRegulatory : templates.defender, {});
}

function portalUrl(
  cloud: CloudProfile,
  template: string,
  values: Record<string, string>
): string {
  const path = Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, value),
    template
  );
  return `${cloud.portalUrl}${path.startsWith("/") ? "" : "/"}${path}`;
}
