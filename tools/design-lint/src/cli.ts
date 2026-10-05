import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { globSync } from 'node:fs';
import { extractInlineStyles, findRawValues } from './raw-values.ts';

/**
 * Fails when a console stylesheet — or an inline `style="…"`/`styles: [...]` — uses a raw
 * colour, length, duration or z-index instead of a Paper Desk token. Runs as the `lint` target
 * of this project, so `nx run-many -t lint` (the contract command and CI) includes it.
 *
 *   node tools/design-lint/src/cli.ts [workspace root]
 */
const root = resolve(process.argv[2] ?? '.');

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
let stylesheetsChecked = 0;

for (const file of styleFiles) {
  const css = readFileSync(resolve(root, file), 'utf8');
  const isTokens = file === TOKENS_FILE;
  const findings = findRawValues(css, { allowTokenDefinitions: isTokens });
  stylesheetsChecked += 1;
  for (const finding of findings) {
    failures += 1;
    console.error(
      `${relative(root, resolve(root, file))}:${finding.line}  raw ${finding.kind} ${finding.value}  in "${finding.declaration}"`,
    );
  }
}

for (const file of inlineStyleFiles) {
  const source = readFileSync(resolve(root, file), 'utf8');
  for (const block of extractInlineStyles(source)) {
    stylesheetsChecked += 1;
    for (const finding of findRawValues(block.css)) {
      failures += 1;
      const line = block.startLine + finding.line - 1;
      console.error(
        `${relative(root, resolve(root, file))}:${line}  raw ${finding.kind} ${finding.value}  in "${finding.declaration}" (inline style)`,
      );
    }
  }
}

if (failures > 0) {
  console.error(`\ndesign-lint: ${failures} raw value(s) in ${stylesheetsChecked} stylesheet(s); use the tokens in ${TOKENS_FILE}.`);
  process.exit(1);
}
console.log(`design-lint: ${stylesheetsChecked} stylesheet(s) use tokens only.`);
