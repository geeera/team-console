import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { globSync } from 'node:fs';
import { findGridsWithoutColumns, gridFilesOverBaseline } from './grid-columns.ts';
import { findNativePickers } from './native-pickers.ts';
import { extractInlineStyles, findRawValues } from './raw-values.ts';

/**
 * Fails when a console stylesheet — or an inline `style="…"`/`styles: [...]` — uses a raw
 * colour, length, duration or z-index instead of a Paper Desk token. Runs as the `lint` target
 * of this project, so `nx run-many -t lint` (the contract command and CI) includes it. It also fails on a native
 * date or time input (#307): the console's date field is the kit's `DatePicker`. And on a `display: grid` rule with
 * no `grid-template-columns` (#839), beyond the files in `grid-columns-baseline.json` that predate the rule: a file may
 * not get more such rules than its baseline count.
 *
 *   node tools/design-lint/src/cli.ts [workspace root]
 */
const root = resolve(process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? '.');

/** Every stylesheet the console app and its libs ship; the tokens file is the one place raw values belong. */
const STYLE_GLOBS = ['libs/console/**/*.css', 'apps/console/src/**/*.css'];
/** Templates and components that may carry inline styles instead of a stylesheet (#78). */
const INLINE_STYLE_GLOBS = [
  'libs/console/**/*.ts',
  'libs/console/**/*.html',
  'apps/console/src/**/*.ts',
  'apps/console/src/**/*.html',
];
const EXCLUDED = ['node_modules', '/dist/'];
const TOKENS_FILE = 'libs/console/shared/ui/src/tokens/tokens.css';

const styleFiles = STYLE_GLOBS.flatMap((pattern) => globSync(pattern, { cwd: root }))
  .filter((file) => !EXCLUDED.some((part) => file.includes(part)))
  .sort();
const inlineStyleFiles = INLINE_STYLE_GLOBS.flatMap((pattern) => globSync(pattern, { cwd: root }))
  .filter((file) => !EXCLUDED.some((part) => file.includes(part)))
  .sort();

let failures = 0;
/** Per file: its grid findings as report lines. The baseline lists the files that predate the rule (#839). */
const gridFindings = new Map<string, string[]>();
const GRID_BASELINE_FILE = resolve(import.meta.dirname, '../grid-columns-baseline.json');
const reportGrid = (file: string, line: number, selector: string, suffix = ''): void => {
  const lines = gridFindings.get(file) ?? [];
  lines.push(`${file}:${line}  display: grid without grid-template-columns  in "${selector}"${suffix}`);
  gridFindings.set(file, lines);
};
let stylesheetsChecked = 0;

for (const file of styleFiles) {
  const css = readFileSync(resolve(root, file), 'utf8');
  const isTokens = file === TOKENS_FILE;
  const findings = findRawValues(css, { allowTokenDefinitions: isTokens });
  stylesheetsChecked += 1;
  for (const grid of findGridsWithoutColumns(css)) {
    reportGrid(file, grid.line, grid.selector);
  }
  for (const finding of findings) {
    failures += 1;
    console.error(
      `${relative(root, resolve(root, file))}:${finding.line}  raw ${finding.kind} ${finding.value}  in "${finding.declaration}"`,
    );
  }
}

let nativePickers = 0;

for (const file of inlineStyleFiles) {
  const source = readFileSync(resolve(root, file), 'utf8');
  for (const picker of findNativePickers(source)) {
    nativePickers += 1;
    console.error(
      `${relative(root, resolve(root, file))}:${picker.line}  native ${picker.type} input  "${picker.snippet}"; use the kit's DatePicker (@console/shared/ui)`,
    );
  }
  for (const block of extractInlineStyles(source)) {
    stylesheetsChecked += 1;
    for (const grid of findGridsWithoutColumns(block.css)) {
      reportGrid(file, block.startLine + grid.line - 1, grid.selector, ' (inline style)');
    }
    for (const finding of findRawValues(block.css)) {
      failures += 1;
      const line = block.startLine + finding.line - 1;
      console.error(
        `${relative(root, resolve(root, file))}:${line}  raw ${finding.kind} ${finding.value}  in "${finding.declaration}" (inline style)`,
      );
    }
  }
}

if (nativePickers > 0) {
  console.error(
    `\ndesign-lint: ${nativePickers} native date/time input(s); the console uses the kit's DatePicker.`,
  );
}

if (failures > 0) {
  console.error(
    `\ndesign-lint: ${failures} raw value(s) in ${stylesheetsChecked} stylesheet(s); use the tokens in ${TOKENS_FILE}.`,
  );
}
const gridCounts = Object.fromEntries(
  [...gridFindings].map(([file, lines]) => [file, lines.length] as const).sort(([a], [b]) => a.localeCompare(b)),
);
if (process.argv.includes('--write-grid-baseline')) {
  writeFileSync(GRID_BASELINE_FILE, `${JSON.stringify(gridCounts, null, 2)}\n`);
  console.log(`design-lint: wrote ${GRID_BASELINE_FILE}`);
  process.exit(0);
}
const gridBaseline = JSON.parse(readFileSync(GRID_BASELINE_FILE, 'utf8')) as Record<string, number>;
const gridOver = gridFilesOverBaseline(gridCounts, gridBaseline);
for (const file of gridOver) {
  for (const line of gridFindings.get(file) ?? []) {
    console.error(line);
  }
}
if (gridOver.length > 0) {
  console.error(
    `\ndesign-lint: more display: grid rule(s) without grid-template-columns than the baseline allows in ${gridOver.length} file(s) (an implicit auto track overflows, #839); set the columns, e.g. minmax(0, 1fr), or add "grid-columns-ok: <why>" inside the rule.`,
  );
}
const gridFixed = Object.keys(gridBaseline).filter((file) => (gridCounts[file] ?? 0) < (gridBaseline[file] ?? 0));
if (gridFixed.length > 0) {
  console.log(`design-lint: ${gridFixed.length} file(s) are below their grid baseline; lower it with --write-grid-baseline.`);
}
if (failures > 0 || nativePickers > 0 || gridOver.length > 0) {
  process.exit(1);
}
console.log(`design-lint: ${stylesheetsChecked} stylesheet(s) use tokens only; no native date/time inputs; no new implicit grid columns.`);
