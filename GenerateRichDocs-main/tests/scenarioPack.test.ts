import test from "node:test";
import assert from "node:assert/strict";
import { createScenarioPack } from "../src/core/seedFactory.js";
import type { ScenarioBrief } from "../src/core/types.js";
import { MockCreativeProvider } from "../src/providers/mockCreativeProvider.js";

const provider = new MockCreativeProvider();

function createBrief(overrides: Partial<ScenarioBrief> = {}): ScenarioBrief {
  return {
    scenarioId: "correspondence-dossier",
    locale: "en",
    seed: 42,
    outputDir: "generated/test",
    ...overrides
  };
}

test("createScenarioPack is deterministic for the same seed and scenario", async () => {
  const first = await createScenarioPack(createBrief(), provider);
  const second = await createScenarioPack(createBrief(), provider);

  assert.deepEqual(first.country, second.country);
  assert.deepEqual(first.organizations, second.organizations);
  assert.deepEqual(first.people, second.people);
  assert.deepEqual(first.reports, second.reports);
  assert.deepEqual(first.emails, second.emails);
  assert.deepEqual(first.events, second.events);
});

test("createScenarioPack changes content when seed changes", async () => {
  const first = await createScenarioPack(createBrief({ seed: 42 }), provider);
  const second = await createScenarioPack(createBrief({ seed: 43 }), provider);

  assert.notDeepEqual(first.country, second.country);
  assert.notDeepEqual(first.reports.map((report) => report.title), second.reports.map((report) => report.title));
});

test("createScenarioPack keeps user-facing prose free of explicit fictional labels", async () => {
  const pack = await createScenarioPack(createBrief(), provider);

  for (const report of pack.reports) {
    assert.equal(report.summary.toLowerCase().includes("fictional"), false);
    assert.equal(report.body.some((paragraph) => paragraph.toLowerCase().includes("fictional")), false);
  }

  for (const email of pack.emails) {
    assert.equal(email.plainTextBody.toLowerCase().includes("fictional"), false);
    assert.equal(email.htmlBody.toLowerCase().includes("fictional"), false);
  }
});

test("createScenarioPack keeps internal identifiers out of report and email prose", async () => {
  const pack = await createScenarioPack(createBrief(), provider);
  const internalIdentifierPattern = /\b(?:org|person|report|email|thread|country)-[a-z0-9-]+\b/i;

  for (const report of pack.reports) {
    assert.equal(internalIdentifierPattern.test(report.summary), false);
    assert.equal(report.body.some((paragraph) => internalIdentifierPattern.test(paragraph)), false);
  }

  for (const email of pack.emails) {
    assert.equal(internalIdentifierPattern.test(email.plainTextBody), false);
    assert.equal(internalIdentifierPattern.test(email.htmlBody), false);
  }
});

test("createScenarioPack assigns one unique primary format per report", async () => {
  const pack = await createScenarioPack(createBrief(), provider);
  const formats = pack.reports.map((report) => report.outputFormat);

  assert.equal(new Set(formats).size, pack.reports.length);
});

test("createScenarioPack honors generation profile overrides", async () => {
  const pack = await createScenarioPack(
    createBrief({
      countryId: "country-astriv",
      generationProfile: {
        peoplePerOrganization: 3,
        reportCount: 8,
        emailCount: 6,
        csvScale: 2
      }
    }),
    provider
  );

  assert.equal(pack.country.id, "country-astriv");
  assert.equal(pack.generationProfile.peoplePerOrganization, 3);
  assert.equal(pack.generationProfile.reportCount, 8);
  assert.equal(pack.generationProfile.emailCount, 6);
  assert.equal(pack.generationProfile.csvScale, 2);
  assert.equal(pack.people.length, pack.organizations.length * 3);
  assert.equal(pack.reports.length, 8);
  assert.equal(pack.emails.length, 6);
});