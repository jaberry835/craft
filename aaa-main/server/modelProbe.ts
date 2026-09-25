import 'dotenv/config';
import path from 'node:path';
import { ModelConnectionConfig } from './services/modelConnectionConfig.js';
import { formatProbeReport, probeModelConnection } from './services/modelProbe.js';

const repositoryRoot = process.env.AAA_ROOT ? path.resolve(process.env.AAA_ROOT) : process.cwd();
const config = await ModelConnectionConfig.load(path.join(repositoryRoot, 'config', 'agent-connections.json'));
const status = config.status();
if (!status.ready) {
  console.error(`Model connection is not ready. Missing: ${status.missing.join(', ')}`);
  process.exit(1);
}

console.log(`Probing ${status.endpointHost ?? 'endpoint'} (deployment ${status.deployment}, endpointKind ${status.endpointKind}, configured api ${status.api})...\n`);
const report = await probeModelConnection(config.resolve());
console.log(formatProbeReport(report));
process.exit(report.recommended ? 0 : 1);
