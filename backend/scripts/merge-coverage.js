import fs from 'fs';
import path from 'path';
import libCoverage from 'istanbul-lib-coverage';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';

const unitJson = path.resolve('coverage/unit/coverage-final.json');
const integrationJson = path.resolve('coverage/integration/coverage-final.json');
const outputDir = path.resolve('coverage/merged');

if (!fs.existsSync(unitJson)) {
  console.error(`Error: Unit test coverage file not found at ${unitJson}`);
  process.exit(1);
}

if (!fs.existsSync(integrationJson)) {
  console.error(`Error: Integration test coverage file not found at ${integrationJson}`);
  process.exit(1);
}

console.log('Merging coverage reports...');

const coverageUnit = JSON.parse(fs.readFileSync(unitJson, 'utf8'));
const coverageIntegration = JSON.parse(fs.readFileSync(integrationJson, 'utf8'));

const map = libCoverage.createCoverageMap();
map.merge(coverageUnit);
map.merge(coverageIntegration);

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'coverage-final.json'), JSON.stringify(map.toJSON()), 'utf8');

const context = libReport.createContext({
  dir: outputDir,
  defaultSummaryVar: 'dir',
  watermarks: {
    statements: [50, 80],
    functions: [50, 80],
    branches: [50, 80],
    lines: [50, 80]
  },
  coverageMap: map
});

console.log('\n=== Merged Coverage Summary ===');
const textSummaryReport = reports.create('text-summary');
textSummaryReport.execute(context);

console.log('\n=== Merged Coverage Details ===');
const textReport = reports.create('text');
textReport.execute(context);

// Generate HTML and json-summary reports
const htmlReport = reports.create('html');
htmlReport.execute(context);

const summaryReport = reports.create('json-summary');
summaryReport.execute(context);

console.log(`\nMerged coverage reports generated at: ${outputDir}`);
