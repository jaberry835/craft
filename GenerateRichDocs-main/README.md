# GenerateRichDocs

GenerateRichDocs is a CLI-first TypeScript project for building seeded document packs that share recurring entities, events, and narrative threads across multiple output formats.

The current implementation is English-first, but the code is structured for later localization to Chinese, Russian, Arabic, and Spanish.

## Current capabilities

- Seeded scenario generation for repeatable output packs
- Six scenario presets:
  - `government-economy`
  - `government-mining-trade`
  - `company-market-report`
  - `correspondence-dossier`
  - `talent-mobility`
  - `permits-procurement`
- Output formats:
  - Varied report formats selected per document from TXT, HTML, DOCX, and PDF
  - CSV exports, including ADX-friendly operational datasets for people, addresses, vehicles, toll traffic, airport border crossings, flight manifests, and person mention linkages
  - KQL setup scripts for Azure Data Explorer table creation, CSV ingestion mappings, and sample ingest commands
  - JSONL exports for ingestion-ready entity/event records
  - XLSX workbook exports
  - Email JSON views
  - Email TXT and HTML views
  - EML email packages with report attachments
- Manifest and normalized entity export for downstream ingestion
- Validation command for artifact completeness and internal reference consistency

## Stack

- Node.js
- TypeScript
- Commander for CLI parsing
- Faker for seeded scenario data
- EJS for English templates
- `docx`, `pdfkit`, `exceljs` for binary outputs
- Azure OpenAI provider support with a mock fallback when env vars are missing

## Getting started

```bash
npm install
npm run typecheck
```

If you want Azure OpenAI-backed drafting, copy `.env.example` into `.env` and populate the values.

## Generate a pack

```bash
npm run generate -- --scenario correspondence-dossier --locale en --data-language ru --seed 42 --validate
```

This writes a pack to `generated/<scenario>-<locale>-seed-<seed>` by default.

If you pin a country with `--country`, the default output folder becomes `generated/<scenario>-<locale>-<country>-seed-<seed>`.

Use `--data-language` when you want operational CSV names, place labels, and border-travel labels rendered in a different supported language from the document locale. Operational datasets can now mix organization-native languages within the same pack.

The scenario registry now groups each preset into topic families. The two new presets are aimed at the first expansion wave:

- `talent-mobility` for resumes, candidate screening, interview scheduling, relocation, and work-travel correspondence
- `permits-procurement` for permit workflows, vendor due diligence, procurement review, shipment clearance, and travel-permit escalation

### Generation options for larger datasets

The generate command now supports dataset sizing controls directly from the CLI:

- `--country <countryId>` to lock a pack to `country-veloria`, `country-astriv`, or `country-demeris`
- `--people-per-organization <count>` to increase entity density and downstream relational rows
- `--report-count <count>` to generate more primary reports
- `--email-count <count>` to generate more linked email traffic
- `--csv-scale <count>` to multiply operational CSV row volume for vehicles, toll traffic, border crossings, and manifests

Example medium pack:

```bash
npm run generate -- --scenario correspondence-dossier --locale en --country country-astriv --seed 42 --people-per-organization 4 --report-count 40 --email-count 80 --csv-scale 3 --validate
```

To print the full provider prompts in terminal output for debugging, add `--show-prompts`:

```bash
npm run generate -- --scenario correspondence-dossier --locale en --seed 42 --show-prompts
```

Example large pack intended for haystack-style search and workflow demos:

```bash
npm run generate -- --scenario government-mining-trade --locale en --country country-demeris --seed 120 --people-per-organization 8 --report-count 250 --email-count 500 --csv-scale 6 --output-dir generated/large-demeris-seed-120
```

For very large runs, leave Azure OpenAI environment variables unset so the mock provider is used. The mock provider keeps the generation deterministic and avoids one LLM request per report and email.

### Multi-country dataset recipes

Because each pack is still organized around one primary fictional country, the simplest way to build a broader corpus is to generate multiple packs and ingest them together.

You can now batch that pattern directly from the CLI and get a root `corpus-manifest.json` that inventories every generated pack.

```bash
tsx src/cli/index.ts generate-corpus --scenarios correspondence-dossier,talent-mobility --countries country-veloria,country-astriv --seed 500 --people-per-organization 4 --report-count 12 --email-count 20 --csv-scale 2 --output-dir generated/demo-corpus --validate
```

Once a corpus has been generated, you can prepare the upload and ADX ingest scripts directly from that corpus root:

```bash
tsx src/cli/index.ts prepare-corpus-ingest --corpus-dir generated/demo-corpus
```

To turn those prepared templates into execution-ready files with your storage settings substituted:

```bash
tsx src/cli/index.ts materialize-corpus-ingest --ingest-dir generated/demo-corpus/ingest --storage-account mystorageacct --container demo-corpus --blob-prefix generated-demo --sas-token "?sv=..."
```

The same values can also come from environment variables:

- `AZURE_STORAGE_ACCOUNT_NAME`
- `AZURE_STORAGE_CONTAINER_NAME`
- `AZURE_STORAGE_BLOB_PREFIX`
- `AZURE_STORAGE_SAS_TOKEN`

This writes an `ingest/` folder under the corpus directory with:

- `upload-corpus-to-blob.ps1` to upload the corpus to Azure Blob Storage via `az storage blob upload-batch`
- `adx-create-tables.kql` to create or merge the target ADX tables
- `adx-create-mappings.kql` to create the CSV ingestion mappings
- `adx-ingest-corpus.kql` to ingest every generated CSV export from Blob storage after placeholder substitution

PowerShell example for one scenario across all fictional countries:

```powershell
$countries = @("country-veloria", "country-astriv", "country-demeris")
$seed = 100

foreach ($country in $countries) {
  npm run generate -- --scenario correspondence-dossier --locale en --country $country --seed $seed --people-per-organization 6 --report-count 120 --email-count 240 --csv-scale 4 --output-dir "generated/correspondence-dossier-$country-seed-$seed" --validate
  $seed += 1
}
```

PowerShell example for a mixed multi-pack corpus:

```powershell
$countries = @("country-veloria", "country-astriv", "country-demeris")
$scenarios = @("correspondence-dossier", "government-mining-trade", "talent-mobility", "permits-procurement")
$seed = 500

foreach ($scenario in $scenarios) {
  foreach ($country in $countries) {
    npm run generate -- --scenario $scenario --locale en --country $country --seed $seed --people-per-organization 5 --report-count 90 --email-count 180 --csv-scale 5 --output-dir "generated/$scenario-$country-seed-$seed"
    $seed += 1
  }
}
```

This pattern gives you multiple countries, repeated organizations, larger operational CSVs, and enough cross-pack noise to test retrieval, linking, and agentic search workflows over a broader corpus.

## Validate an existing pack

```bash
npm run validate -- --output-dir generated/correspondence-dossier-en-seed-42
```

Validation writes `validation-report.json` into the generated pack directory.

## List scenarios

```bash
tsx src/cli/index.ts list-scenarios
```

This now prints each scenario description plus its configured topic families.

## Project layout

```text
src/
  cli/            CLI commands
  core/           Shared domain types, seeded scenario engine, template loader
  generators/     Format-specific writers and manifest generation
  locales/        Template bundles, currently English only
  providers/      Azure OpenAI provider and mock fallback
  scenarios/      Scenario catalog metadata
  types/          Local declaration files for packages without published types
  validators/     Generated pack integrity checks
```

## Current notes

- The project is intentionally limited to invented institutions, people, domains, and report content.
- CSV exports now include high-volume, flat relational tables intended for Azure Data Explorer ingestion, with locale-aware text fields keyed off the selected pack locale.
- Operational CSV exports can render names and place labels in a separate `--data-language`, independent from the document template locale, and organization-linked rows can vary by native language inside one pack.
- The manifest now records the selected country and generation profile so downstream ingest and validation can understand how a pack was sized.
- Images are still deferred.
- Locale plumbing exists, but non-English template bundles are not implemented yet.
- The current EML dependency works, but it is based on an older package ecosystem and may be swapped later if a better maintained option is needed.

## Dataset design suggestions

- Add recurring watchlist entities across packs, such as the same executive, broker, port operator, or shell vendor appearing in otherwise unrelated documents.
- Introduce low-frequency anomalies in the CSV datasets, such as unusual toll cadence, repeated airport routes, or address reuse across multiple people and vehicles.
- Add time-based noise by generating routine benign traffic alongside a smaller set of high-signal clusters, so retrieval tasks must separate normal background activity from relevant threads.
- Add cross-pack shared identifiers that are not exact string matches, such as transliterated person names, alternate organization renderings, or reused attachment titles.
- Extend the operational side with financial ledger rows, procurement line items, shipment/container events, telecom metadata, or meeting attendance logs if you want more surfaces for MCP-connected workflows.