import { GitHubError } from './errors';

/**
 * The named one-repository mints of the console app (#670, #759; security note on #759, PR 1). There is no mint with
 * a free-form permission set: a caller names a kind, each kind maps to one frozen permission set below, and
 * `tools/workspace-checks/src/scoped-mint-kinds.spec.ts` pins which module may name each kind. Every scoped token is
 * minted per call with `repository_ids: [one id]`, never cached, stored or logged, and revoked once its calls are made.
 */

/**
 * #670 (ADR 0008 item 9, owner decision 1 on #573): `workflow_dispatch` of the runner workflow, the one automated
 * scoped mint.
 */
export const ACTIONS_DISPATCH_PERMISSIONS: Readonly<Record<string, 'write'>> = Object.freeze({
  actions: 'write',
});

/**
 * #759: the readiness read of the Actions setup — the `team-console` Environment and its deployment-branch policies
 * (Actions: read) and whether its one secret exists (Environments: read). Minted per check and never added to the
 * cached read token, which would otherwise read every Environment's secret names and variables for an hour.
 */
export const ENVIRONMENT_READ_PERMISSIONS: Readonly<Record<string, 'read'>> = Object.freeze({
  actions: 'read',
  environments: 'read',
});

/**
 * #759: the setup write — one branch, the one workflow file on it and its pull request, on the account owner's click.
 * The only permission set that holds `workflows: write` (threat model C5 row 2, R8: a job token never carries it).
 */
export const WORKFLOW_PR_PERMISSIONS: Readonly<Record<string, 'write'>> = Object.freeze({
  contents: 'write',
  workflows: 'write',
  pull_requests: 'write',
});

export const SCOPED_MINT_KINDS = ['actions-dispatch', 'environment-read', 'workflow-pr'] as const;
export type ScopedMintKind = (typeof SCOPED_MINT_KINDS)[number];

export const SCOPED_MINT_PERMISSIONS: {
  readonly [K in ScopedMintKind]: Readonly<Record<string, 'read' | 'write'>>;
} = Object.freeze({
  'actions-dispatch': ACTIONS_DISPATCH_PERMISSIONS,
  'environment-read': ENVIRONMENT_READ_PERMISSIONS,
  'workflow-pr': WORKFLOW_PR_PERMISSIONS,
});

/**
 * The kinds behind the operator's kill switch. The dispatch mint is not one of them: it has its own owner approval
 * (ADR 0008 item 9) and runs from the queue.
 */
export const SWITCHED_SCOPED_KINDS: ReadonlySet<ScopedMintKind> = new Set<ScopedMintKind>(['workflow-pr']);

/** The installation and the one repository, by id, a scoped token is minted for: always the project row's own. */
export interface ScopedMintTarget {
  readonly installationId: number;
  readonly repositoryId: number;
}

export interface ScopedMintFacts extends ScopedMintTarget {
  readonly kind: ScopedMintKind;
}

/** Why a scoped mint handed out no token: a fixed enum, never GitHub's text. */
export type ScopedMintFailure =
  | 'write-disabled'
  | 'permission-missing'
  | 'installation-missing'
  | 'scope-mismatch'
  | 'github-auth'
  | 'github-unavailable'
  | 'github-error'
  | 'internal';

/** What the audit hook hears: ids and enums only, never the token (the `audit_events.details` rule). */
export type ScopedMintEvent =
  | (ScopedMintFacts & { readonly outcome: 'attempted' | 'minted' })
  | (ScopedMintFacts & {
      readonly outcome: 'failed';
      readonly failure: ScopedMintFailure;
      readonly githubStatus: number | null;
    });

/**
 * Hears every scoped mint: `attempted` before anything is sent, then `minted` or `failed`. A throwing `attempted`
 * stops the mint and a throwing `minted` revokes the token, so no token goes out unaudited; a throwing `failed` is
 * logged and the mint's own error is what the caller gets.
 */
export type ScopedMintAudit = (event: ScopedMintEvent) => Promise<void>;

/**
 * A minted one-repository token of one kind. The bearer sits in a private field, so `JSON.stringify`, a log field or a
 * template string of the object never carries it, and each GitHub helper takes a token of its own kind only.
 */
export class ScopedInstallationToken<K extends ScopedMintKind = ScopedMintKind> {
  readonly #bearer: string;

  constructor(
    readonly kind: K,
    readonly installationId: number,
    readonly repositoryId: number,
    bearer: string,
  ) {
    this.#bearer = bearer;
  }

  /** The `Authorization` value of this token's own calls; never log, store or return it. */
  bearer(): string {
    return this.#bearer;
  }

  toJSON(): ScopedMintFacts {
    return { kind: this.kind, installationId: this.installationId, repositoryId: this.repositoryId };
  }

  toString(): string {
    return `[${this.kind} installation token]`;
  }
}

/** Refuses a helper call with a token of another kind; the types already forbid it, this holds for casts too. */
export function assertScopedKind<K extends ScopedMintKind>(
  token: ScopedInstallationToken,
  kind: K,
): asserts token is ScopedInstallationToken<K> {
  if (token.kind !== kind) {
    throw new TypeError(`this GitHub call takes a ${kind} token`);
  }
}

/**
 * 503 `github-write-disabled` (#759): the operator's kill switch (`ALLOW_ACTIONS_SETUP_WRITE`) is off on this Worker,
 * so the write mint was refused before anything was asked of GitHub.
 */
export function setupWriteDisabledError(): GitHubError {
  return new GitHubError(
    {
      type: 'github-write-disabled',
      title: 'Writing to the repository is switched off on this console',
      status: 503,
      detail: 'The operator has switched off the GitHub write path of the Actions setup',
    },
    null,
  );
}

/** The fixed failure a scoped mint's error is put down to. */
export function scopedMintFailureOf(error: unknown): ScopedMintFailure {
  if (!(error instanceof GitHubError)) {
    return 'internal';
  }
  switch (error.problem.type) {
    case 'github-write-disabled':
      return 'write-disabled';
    case 'github-auth':
      return 'github-auth';
    case 'github-unavailable':
    case 'github-rate-limit':
      return 'github-unavailable';
    default:
      break;
  }
  const status = error.githubStatus;
  // GitHub answers 422 to a mint asking for a permission the installation was not granted.
  if (status === 422) {
    return 'permission-missing';
  }
  if (status === 404) {
    return 'installation-missing';
  }
  // A 2xx the console refused: GitHub minted another scope than the one asked for (`judgeMint`).
  return status !== null && status >= 200 && status < 300 ? 'scope-mismatch' : 'github-error';
}

export function assertScopedTarget(target: ScopedMintTarget): void {
  for (const id of [target.installationId, target.repositoryId]) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new RangeError('a scoped mint names its installation and repository by positive integer id');
    }
  }
}

/** The log line of a failed revoke, per kind; the dispatch keeps its #723 wording. */
export const SCOPED_REVOKE_FAILURE: { readonly [K in ScopedMintKind]: string } = Object.freeze({
  'actions-dispatch': 'dispatch installation token not revoked',
  'environment-read': 'environment-read installation token not revoked',
  'workflow-pr': 'workflow-pr installation token not revoked',
});
