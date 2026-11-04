import { workspaceRoot } from '@nx/devkit';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { DEPLOY_ENVIRONMENTS, WORKER_APPS, readWorkerConfig } from './support/wrangler-config';

/**
 * #102: `.product-team/environment-manifest.yml` is the single source listing every secret and variable the
 * console needs, for each environment — #103's setup script and #104's Environment setup screen both render
 * their guides from it, never from a second copy. This spec enforces the two guarantees that make that
 * possible:
 *  - the manifest's shape never carries a value, a value length or a hash — only names and prose;
 *  - every name actually used by the four sources below has exactly one manifest entry, and every manifest
 *    entry is used by at least one of them, so the manifest can never silently drift from the code.
 */

const MANIFEST_PATH = '.product-team/environment-manifest.yml';
const WORKFLOWS_DIR = '.github/workflows';

// GitHub Actions' own built-in per-run token (branch-guard.yml, owner-digest.yml): never configured by the
// owner, so it needs no manifest entry (CLAUDE.md, apps/*/src/env.ts already document this).
const BUILTIN_NAMES: ReadonlySet<string> = new Set(['GITHUB_TOKEN']);

const LOCATION_PLACES = [
  'wrangler-secret',
  'wrangler-var',
  'github-environment-secret',
  'github-environment-variable',
  'github-repository-secret',
  'local-only',
] as const;

const ALLOWED_TOP_KEYS = new Set(['environments', 'items']);
const ALLOWED_ITEM_KEYS = new Set([
  'name',
  'pattern',
  'kind',
  'origin',
  'environments',
  'locations',
  'neededBy',
  'purpose',
  'guide',
]);
const ALLOWED_LOCATION_KEYS = new Set(['place', 'app']);
const ALLOWED_GUIDE_KEYS = new Set(['obtain', 'scopes', 'rotation', 'gotchas']);

interface ManifestLocation {
  readonly place: string;
  readonly app?: string;
}

interface ManifestGuide {
  readonly obtain: string | null;
  readonly scopes: string | null;
  readonly rotation: string | null;
  readonly gotchas: string | null;
}

interface ManifestItem {
  readonly name: string;
  readonly pattern?: boolean;
  readonly kind: 'secret' | 'variable';
  readonly origin: 'owner' | 'generated';
  readonly environments: readonly string[];
  readonly locations: readonly ManifestLocation[];
  readonly neededBy: readonly string[];
  readonly purpose: string;
  readonly guide: ManifestGuide;
}

interface Manifest {
  readonly environments: readonly string[];
  readonly items: readonly ManifestItem[];
}

function readText(relativePath: string): string {
  return readFileSync(join(workspaceRoot, relativePath), 'utf8');
}

function loadManifest(): { raw: string; parsed: unknown; manifest: Manifest } {
  const raw = readText(MANIFEST_PATH);
  const parsed = parse(raw) as unknown;
  return { raw, parsed, manifest: parsed as Manifest };
}

// --- pure extractors: each takes plain text (or a config object) and returns the names it finds. Kept pure
// and exported-in-file-only so the tests below can feed synthetic text and prove the detection logic. -------

/** `readonly NAME: string` / `readonly NAME?: string` fields of a Worker `env.ts` interface — never a binding
 * type like `D1Database` or `Fetcher`, so resource bindings (DB, ASSETS) are not mistaken for configuration. */
function extractEnvTsNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/readonly\s+([A-Z][A-Z0-9_]*)\??:\s*string\b/g)) {
    names.add(match[1] as string);
  }
  return [...names];
}

/** Every key of a wrangler.jsonc env's `vars` object (union across the given per-environment configs). */
function extractWranglerVarNames(varsObjects: readonly Readonly<Record<string, unknown>>[]): string[] {
  const names = new Set<string>();
  for (const vars of varsObjects) {
    for (const key of Object.keys(vars)) {
      names.add(key);
    }
  }
  return [...names];
}

/** `secrets.NAME` / `vars.NAME` in workflow YAML, skipping comment lines (so a comment merely describing the
 * pattern, like deploy.yml's `vars.CONSOLE_NAME` example, is never read as real usage) and the GitHub-Actions
 * built-in `GITHUB_TOKEN`. */
function extractWorkflowNames(source: string): string[] {
  const names = new Set<string>();
  const codeLines = source.split('\n').filter((line) => !line.trim().startsWith('#'));
  for (const match of codeLines.join('\n').matchAll(/\b(?:secrets|vars)\.([A-Z][A-Z0-9_]*)/g)) {
    const name = match[1] as string;
    if (!BUILTIN_NAMES.has(name)) {
      names.add(name);
    }
  }
  return [...names];
}

/** Names an owner-setup script actually provisions: a direct `gh secret set NAME` / `gh variable set NAME` /
 * `… secret put NAME` call, or a call to set-secrets.sh's two literal-name helpers (`set_gh_secret "${env}"
 * NAME …`, `put_worker_secret "${CONFIG}" "${env}" NAME …`). Deliberately narrow: it is not "every
 * SCREAMING_SNAKE_CASE identifier in the script" (that would also catch the script's own local shell
 * variables and the create-apps.sh App Manifest test knobs, which are not environment configuration). */
function extractOwnerSetupNames(source: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /\bgh secret set "?([A-Z][A-Z0-9_]*)"?/g,
    /\bgh variable set "?([A-Z][A-Z0-9_]*)"?/g,
    /\bsecret put "?([A-Z][A-Z0-9_]*)"?/g,
    /\bset_gh_secret\s+"\$\{env\}"\s+([A-Z][A-Z0-9_]*)/g,
    /\bput_worker_secret\s+"\$\{\w+\}"\s+"\$\{env\}"\s+([A-Z][A-Z0-9_]*)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      names.add(match[1] as string);
    }
  }
  return [...names];
}

function missingFromManifest(used: Iterable<string>, manifestNames: ReadonlySet<string>): string[] {
  return [...new Set(used)].filter((name) => !manifestNames.has(name) && !BUILTIN_NAMES.has(name)).sort();
}

function orphaned(manifestNames: Iterable<string>, used: ReadonlySet<string>): string[] {
  return [...manifestNames].filter((name) => !used.has(name)).sort();
}

// --- pure extractors, unit-tested against synthetic text (not the real files) ------------------------------

describe('environment-manifest source extractors (synthetic text)', () => {
  it('reads string-typed fields of an env.ts-shaped interface, never a binding type', () => {
    const source = `
      export interface Env {
        readonly FOO_BAR: string;
        readonly BAZ_QUX?: string;
        readonly SOME_BINDING: Fetcher;
        readonly DB: D1Database;
      }
    `;
    expect(extractEnvTsNames(source).sort()).toEqual(['BAZ_QUX', 'FOO_BAR']);
  });

  it('unions vars keys across environments', () => {
    expect(extractWranglerVarNames([{ A: '1', B: '2' }, { B: '2', C: '3' }]).sort()).toEqual(['A', 'B', 'C']);
  });

  it('reads secrets./vars. names, skips comment lines, and drops the GITHUB_TOKEN builtin', () => {
    const source = [
      '      # a comment mentioning vars.NOT_REAL must not count as usage',
      '      one: ${{ secrets.FOO }}',
      '      two: ${{ vars.BAR }}',
      '      three: ${{ secrets.GITHUB_TOKEN }}',
    ].join('\n');
    expect(extractWorkflowNames(source).sort()).toEqual(['BAR', 'FOO']);
  });

  it('reads names an owner-setup script provisions directly and through its helper functions', () => {
    const source = [
      'gh variable set SOME_VAR --repo "${REPO}" --env "${env}"',
      '"${WRANGLER}" secret put SOME_SECRET --env "${env}" --config "${CFG}"',
      'set_gh_secret "${env}" OTHER_SECRET "${value}"',
      'put_worker_secret "${API_WRANGLER}" "${env}" OTHER_KEY "${value}" api',
    ].join('\n');
    expect(extractOwnerSetupNames(source).sort()).toEqual([
      'OTHER_KEY',
      'OTHER_SECRET',
      'SOME_SECRET',
      'SOME_VAR',
    ]);
  });

  it('does not pick up a script-local shell variable as a provisioned name', () => {
    // `APP_NAME` here is never the first literal argument of a provisioning call — a naive
    // "every SCREAMING_SNAKE_CASE identifier" scan would wrongly flag it.
    const source = 'local app_name="team-console-${env}"\necho "${APP_NAME}"\n';
    expect(extractOwnerSetupNames(source)).toEqual([]);
  });
});

// --- the manifest file itself: shape, and no value/length/hash ----------------------------------------------

describe('the manifest holds no values, value lengths or hashes', () => {
  const { raw, parsed } = loadManifest();

  it('parses as YAML with exactly the two documented top-level keys', () => {
    expect(parsed).not.toBeNull();
    expect(typeof parsed).toBe('object');
    for (const key of Object.keys(parsed as object)) {
      expect(ALLOWED_TOP_KEYS.has(key), key).toBe(true);
    }
    expect(ALLOWED_TOP_KEYS.has('items')).toBe(true);
  });

  it('declares the four documented environments, nothing else', () => {
    const manifest = parsed as Manifest;
    expect([...manifest.environments].sort()).toEqual(['dev', 'local', 'production', 'stage']);
  });

  it('gives every item only the documented fields', () => {
    const manifest = parsed as Manifest;
    for (const item of manifest.items) {
      for (const key of Object.keys(item)) {
        expect(ALLOWED_ITEM_KEYS.has(key), `${item.name}.${key}`).toBe(true);
      }
      expect(item.name, 'name').toBeTruthy();
      expect(['secret', 'variable'], item.name).toContain(item.kind);
      expect(['owner', 'generated'], item.name).toContain(item.origin);
      expect(Array.isArray(item.locations), item.name).toBe(true);
      expect(item.locations.length, item.name).toBeGreaterThan(0);
      for (const location of item.locations) {
        for (const key of Object.keys(location)) {
          expect(ALLOWED_LOCATION_KEYS.has(key), `${item.name}.locations.${key}`).toBe(true);
        }
        expect(LOCATION_PLACES as readonly string[], item.name).toContain(location.place);
      }
      for (const key of Object.keys(item.guide)) {
        expect(ALLOWED_GUIDE_KEYS.has(key), `${item.name}.guide.${key}`).toBe(true);
      }
    }
  });

  it('never names a field that could carry a value, a length or a hash', () => {
    // A conservative key-shaped scan (word at the start of a YAML key), not a substring scan — so prose that
    // happens to contain one of these words (there is none today) would not itself be a false failure.
    const forbidden = ['value', 'values', 'length', 'len', 'hash', 'checksum', 'secretvalue', 'default', 'example', 'sample'];
    for (const word of forbidden) {
      const keyPattern = new RegExp(`^\\s*-?\\s*${word}\\s*:`, 'im');
      expect(keyPattern.test(raw), word).toBe(false);
    }
  });

  it('never contains a run of characters shaped like a real secret value', () => {
    // 32+ contiguous letters/digits with no separators — longer than any identifier this file uses
    // (checked: the longest real one, `projectSlugToRoutineTokenName`, is 30) but the shape a pasted secret,
    // a generated key or a hash would have.
    expect(raw.match(/\b[A-Za-z0-9]{32,}\b/g)).toBeNull();
  });
});

// --- completeness against the real repository ---------------------------------------------------------------

describe('environment-manifest completeness against the real repository', () => {
  const { manifest } = loadManifest();
  const literalItems = manifest.items.filter((item) => !item.pattern);
  const patternItems = manifest.items.filter((item) => item.pattern);
  const manifestNames = new Set(literalItems.map((item) => item.name));

  const envTsText = [readText('apps/api/src/env.ts'), readText('apps/hooks/src/env.ts')].join('\n');
  const envTsNames = new Set(extractEnvTsNames(envTsText));

  const wranglerVarNames = new Set(
    extractWranglerVarNames(
      WORKER_APPS.flatMap((app) => DEPLOY_ENVIRONMENTS.map((env) => readWorkerConfig(app, env).vars)),
    ),
  );

  const workflowFiles = readdirSync(join(workspaceRoot, WORKFLOWS_DIR)).filter((file) => file.endsWith('.yml'));
  const workflowText = workflowFiles.map((file) => readText(join(WORKFLOWS_DIR, file))).join('\n');
  const workflowNames = new Set(extractWorkflowNames(workflowText));

  const ownerSetupText = [
    readText('tools/owner-setup/set-secrets.sh'),
    readText('tools/owner-setup/create-apps.sh'),
  ].join('\n');
  const ownerSetupNames = new Set(extractOwnerSetupNames(ownerSetupText));

  const allUsed = new Set([...envTsNames, ...wranglerVarNames, ...workflowNames, ...ownerSetupNames]);
  const allSourceText = [envTsText, workflowText, ownerSetupText].join('\n');

  it('has a manifest entry for every string field apps/*/src/env.ts declares', () => {
    expect(missingFromManifest(envTsNames, manifestNames)).toEqual([]);
  });

  it('has a manifest entry for every var key wrangler.jsonc declares', () => {
    expect(missingFromManifest(wranglerVarNames, manifestNames)).toEqual([]);
  });

  it('has a manifest entry for every secrets./vars. name the workflows use', () => {
    expect(missingFromManifest(workflowNames, manifestNames)).toEqual([]);
  });

  it('has a manifest entry for every name the owner-setup scripts provision', () => {
    expect(missingFromManifest(ownerSetupNames, manifestNames)).toEqual([]);
  });

  it('has no manifest entry unused by any of the four sources', () => {
    expect(orphaned(manifestNames, allUsed)).toEqual([]);
  });

  it('writes every per-project pattern literally in at least one of the four sources', () => {
    for (const item of patternItems) {
      expect(allSourceText.includes(item.name), item.name).toBe(true);
    }
  });

  // One failing case per source (acceptance criterion): a name a source starts using, with no manifest entry
  // yet, must be caught — proven here against the real, current sets rather than a fixture that could rot.
  it('fails closed when apps/*/src/env.ts gains an unlisted name', () => {
    expect(missingFromManifest([...envTsNames, 'TOTALLY_NEW_ENV_TS_NAME'], manifestNames)).toEqual([
      'TOTALLY_NEW_ENV_TS_NAME',
    ]);
  });

  it('fails closed when a wrangler.jsonc vars block gains an unlisted name', () => {
    expect(missingFromManifest([...wranglerVarNames, 'TOTALLY_NEW_WRANGLER_VAR'], manifestNames)).toEqual([
      'TOTALLY_NEW_WRANGLER_VAR',
    ]);
  });

  it('fails closed when a workflow references an unlisted secrets./vars. name', () => {
    expect(missingFromManifest([...workflowNames, 'TOTALLY_NEW_WORKFLOW_NAME'], manifestNames)).toEqual([
      'TOTALLY_NEW_WORKFLOW_NAME',
    ]);
  });

  it('fails closed when an owner-setup script provisions an unlisted name', () => {
    expect(missingFromManifest([...ownerSetupNames, 'TOTALLY_NEW_OWNER_SETUP_NAME'], manifestNames)).toEqual([
      'TOTALLY_NEW_OWNER_SETUP_NAME',
    ]);
  });
});
