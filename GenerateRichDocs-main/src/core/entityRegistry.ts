import type {
  EmailMessage,
  Organization,
  Person,
  ReportDocument,
  ScenarioPack
} from "./types.js";

export class EntityRegistry {
  public readonly organizations = new Map<string, Organization>();
  public readonly people = new Map<string, Person>();
  public readonly reports = new Map<string, ReportDocument>();
  public readonly emails = new Map<string, EmailMessage>();

  public static fromScenario(pack: ScenarioPack): EntityRegistry {
    const registry = new EntityRegistry();

    for (const organization of pack.organizations) {
      registry.organizations.set(organization.id, organization);
    }

    for (const person of pack.people) {
      registry.people.set(person.id, person);
    }

    for (const report of pack.reports) {
      registry.reports.set(report.id, report);
    }

    for (const email of pack.emails) {
      registry.emails.set(email.id, email);
    }

    return registry;
  }

  public getOrganization(id: string): Organization {
    const organization = this.organizations.get(id);
    if (!organization) {
      throw new Error(`Unknown organization: ${id}`);
    }

    return organization;
  }

  public getPerson(id: string): Person {
    const person = this.people.get(id);
    if (!person) {
      throw new Error(`Unknown person: ${id}`);
    }

    return person;
  }

  public getReport(id: string): ReportDocument {
    const report = this.reports.get(id);
    if (!report) {
      throw new Error(`Unknown report: ${id}`);
    }

    return report;
  }
}