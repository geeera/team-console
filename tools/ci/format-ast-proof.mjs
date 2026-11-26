#!/usr/bin/env node
// Proves a Prettier run is format-only: for every file, the AST of the committed text and of the
// Prettier output must be identical once formatting is ignored. Read-only: nothing is written.
//
//   node tools/ci/format-ast-proof.mjs --between <base> <head> [--write-report <file>]
//   node tools/ci/format-ast-proof.mjs [--list <file>] [--write-report <file>]
//
// --between compares the committed text of every file that differs between two commits, e.g. the
// parent of the format commit and the format commit itself (the re-runnable proof for review).
// Otherwise it simulates the format on the working tree: the files in --list, or every file
// `prettier --list-different` flags.
// Exit code 1 when any file's AST changes or a file cannot be parsed.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import { createRequire } from 'node:module';
import * as prettier from 'prettier';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const ngCompiler = require('@angular/compiler');

// Prettier also reformats Angular inline templates (`template: \`...\``). Those strings legitimately
// change, so they are compared as the Angular compiler sees them: parsed with default whitespace
// handling, source spans dropped.
const SPAN_KEY = /span|Span|^file$|^i18n$|^location$|^source$/;
// `lenient` additionally trims the edges of text nodes: Prettier may add or drop whitespace at the start or
// end of block-level elements (`<p>x</p>` -> `<p>\n x\n</p>`), which Angular collapses to one space.
function ngTemplateShape(text, lenient) {
  const parsed = ngCompiler.parseTemplate(text, 'inline.html', { preserveWhitespaces: false });
  if (parsed.errors?.length) throw new Error(`Angular template does not parse: ${parsed.errors[0].msg}`);
  return JSON.stringify(parsed.nodes, function (key, v) {
    if (SPAN_KEY.test(key)) return undefined;
    if (typeof v === 'bigint') return String(v);
    if (lenient && key === 'value' && typeof v === 'string' && this?.constructor?.name === 'Text')
      return v.trim();
    if (lenient && key === 'strings' && Array.isArray(v) && this?.constructor?.name === 'Interpolation') {
      return v.map((str, i) => (i === 0 ? str.trimStart() : i === v.length - 1 ? str.trimEnd() : str));
    }
    return v;
  });
}
const isPropertyName = (node) =>
  (ts.isIdentifier(node) || ts.isStringLiteral(node)) &&
  (ts.isPropertyAssignment(node.parent) ||
    ts.isPropertySignature(node.parent) ||
    ts.isPropertyDeclaration(node.parent)) &&
  node.parent.name === node;
const isInlineTemplate = (node) =>
  ts.isNoSubstitutionTemplateLiteral(node) &&
  ts.isPropertyAssignment(node.parent) &&
  node.parent.name.getText() === 'template';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const betweenAt = args.indexOf('--between');
const [baseRef, headRef] = betweenAt === -1 ? [] : args.slice(betweenAt + 1, betweenAt + 3);
const listFile = opt('--list');
const reportFile = opt('--write-report');

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 26 });
const files = baseRef
  ? git('diff', '--name-only', '--diff-filter=M', baseRef, headRef).split('\n').filter(Boolean)
  : listFile
    ? readFileSync(listFile, 'utf8').split('\n').filter(Boolean)
    : execFileSync('npx', ['prettier', '--list-different', '.'], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);

const readBefore = (file) => (baseRef ? git('show', `${baseRef}:${file}`) : readFileSync(file, 'utf8'));

// Independent second opinion for script files: the TypeScript compiler's own tree, trivia and
// redundant parentheses dropped, string/number values compared rather than their spelling.
const SCRIPT_EXTS = new Set(['.ts', '.mts', '.js', '.mjs']);
function tsShape(text, file, lenient) {
  const kind = extname(file) === '.ts' || extname(file) === '.mts' ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const out = [];
  const walk = (node) => {
    if (node.kind === ts.SyntaxKind.ParenthesizedExpression) return walk(node.expression);
    if (isInlineTemplate(node)) {
      out.push(`template:${ngTemplateShape(node.text, lenient)}`, ')');
      return;
    }
    if (isPropertyName(node)) {
      // `{ 'a': 1 }` and `{ a: 1 }` are the same property; Prettier unquotes keys when it can.
      out.push(`propname:${node.text}`, ')');
      return;
    }
    const leaf =
      ts.isIdentifier(node) ||
      ts.isPrivateIdentifier(node) ||
      ts.isStringLiteralLike(node) ||
      ts.isNumericLiteral(node)
        ? node.text
        : ts.isRegularExpressionLiteral(node)
          ? node.text
          : '';
    out.push(`${node.kind}:${leaf}`);
    ts.forEachChild(node, walk);
    out.push(')');
  };
  walk(sf);
  return { shape: out.join('|'), syntaxErrors: sf.parseDiagnostics.length };
}

// Prettier's own `--debug-check` comparison: parse with the same parser, drop formatting-only nodes.
async function massagedAst(text, options) {
  return JSON.stringify(await prettier.__debug.parse(text, options, { massage: true }), (key, v) =>
    key === 'tokens' || key === 'comments' ? undefined : v,
  ).replace(/"(start|end|loc|range|extra|raw)":/g, '"_$1":');
}

const rows = [];
for (const file of files) {
  const row = { file, ok: false, reason: '' };
  try {
    const before = readBefore(file);
    const options = { ...(await prettier.resolveConfig(file)), filepath: file };
    // Prettier's member-chain layout needs a second pass on a few files; format to a fixpoint, as
    // `format:check` will see the result of `prettier --write` run until nothing changes.
    let after = baseRef ? git('show', `${headRef}:${file}`) : await prettier.format(before, options);
    let idempotent = false;
    for (let pass = 0; pass < 3 && !idempotent; pass += 1) {
      const next = await prettier.format(after, options);
      idempotent = next === after;
      if (!baseRef) after = next;
      else break;
    }
    const [a, b] = await Promise.all([
      prettier.__debug.parse(before, options, { massage: true }),
      prettier.__debug.parse(after, options, { massage: true }),
    ]);
    const sameMassaged = JSON.stringify(a.ast, stripPositions) === JSON.stringify(b.ast, stripPositions);
    let sameTs = true;
    if (SCRIPT_EXTS.has(extname(file))) {
      const eq = (lenient) => {
        const x = tsShape(before, file, lenient);
        const y = tsShape(after, file, lenient);
        return x.shape === y.shape && x.syntaxErrors === y.syntaxErrors;
      };
      sameTs = eq(false);
      if (!sameTs && eq(true)) {
        sameTs = true;
        row.tier = 'template-whitespace';
      }
    }
    row.ok = sameMassaged && sameTs && idempotent;
    row.reason = [
      !sameMassaged && 'prettier-ast',
      !sameTs && 'typescript-ast',
      !idempotent && 'not-idempotent',
    ]
      .filter(Boolean)
      .join(',');
    row.changed = before !== after;
  } catch (error) {
    row.reason = `error: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
  }
  rows.push(row);
}

function stripPositions(key, value) {
  if (typeof value === 'bigint') return String(value);
  return [
    'start',
    'end',
    'loc',
    'range',
    'extra',
    'raw',
    'tokens',
    'comments',
    'trailingComments',
    'leadingComments',
    'innerComments',
  ].includes(key)
    ? undefined
    : value;
}

const bad = rows.filter((r) => !r.ok);
const report = [
  `files checked: ${rows.length}`,
  `AST identical: ${rows.length - bad.length}`,
  `  of which identical only modulo Angular inline-template edge whitespace: ${rows.filter((r) => r.ok && r.tier).length}`,
  `AST changed or unparsable: ${bad.length}`,
  ...bad.map((r) => `  ${r.file}  ${r.reason}`),
  ...rows.filter((r) => r.ok && r.tier).map((r) => `  [template-whitespace] ${r.file}`),
  '',
].join('\n');
process.stdout.write(report);
if (reportFile) writeFileSync(reportFile, report);
process.exit(bad.length ? 1 : 0);
