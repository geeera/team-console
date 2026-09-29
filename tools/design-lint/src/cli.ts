import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { globSync } from 'node:fs';
import { findRawValues } from './raw-values.ts';

/**
 * Fails when a console stylesheet uses a raw colour, length, duration or z-index instead of
 * a Paper Desk token. Runs as the `lint` target of this project, so `nx run-many -t lint`
 * (the contract command and CI) includes it.
 *
 *   node tools/design-lint/src/cli.ts [workspace root]
 */
const root = resolve(process.argv[2] ?? '.');

/** Every stylesheet the console app and its libs ship; the tokens file is the one place raw values belong. */
const STYLE_GLOBS = ['libs/console/**/*.css', 'apps/console/src/**/*.css'];
const EXCLUDED = ['node_modules', '/dist/'];
const TOKENS_FILE = 'libs/console/shared/ui/src/tokens/tokens.css';

const files = STYLE_GLOBS.flatMap((pattern) => globSync(pattern, { cwd: root }))
  .filter((file) => !EXCLUDED.some((part) => file.includes(part)))
  .sort();

let failures = 0;
for (const file of files) {
  const css = readFileSync(resolve(root, file), 'utf8');
  const isTokens = file === TOKENS_FILE;
  const findings = findRawValues(css, { allowTokenDefinitions: isTokens });
  for (const finding of findings) {
    failures += 1;
    console.error(
      `${relative(root, resolve(root, file))}:${finding.line}  raw ${finding.kind} ${finding.value}  in "${finding.declaration}"`,
    );
  }
}

if (failures > 0) {
  console.error(
    `\ndesign-lint: ${failures} raw value(s) in ${files.length} stylesheet(s); use the tokens in ${TOKENS_FILE}.`,
  );
  process.exit(1);
}
console.log(`design-lint: ${files.length} stylesheet(s) use tokens only.`);
