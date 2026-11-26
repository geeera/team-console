/**
 * One macOS ACL policy, two implementations (#900): `acl_root_only` in the launcher `bin/team-console-runner` (shell
 * globs, at every root start) and `hasForeignWriteAcl` in `install/install.ts` (a regex, at install). Both specs run
 * this table, so a change to one that the other does not follow fails a spec.
 */
export interface AclPolicyCase {
  readonly name: string;
  /** One ACE line as `ls -lde` prints it under the entry. */
  readonly ace: string;
  /** Whether it lets anyone but root change the path, so both sides must refuse it. */
  readonly foreignWrite: boolean;
}

export const ACL_POLICY_CASES: readonly AclPolicyCase[] = [
  { name: 'a user may write and append', ace: ' 0: user:kirill allow write,append', foreignWrite: true },
  {
    name: 'a group may add and delete entries',
    ace: ' 0: group:staff allow add_file,delete_child',
    foreignWrite: true,
  },
  {
    name: 'a user may add a subdirectory',
    ace: ' 0: user:kirill allow add_subdirectory',
    foreignWrite: true,
  },
  {
    name: 'everyone may delete, inherited',
    ace: ' 0: group:everyone inherited allow delete',
    foreignWrite: true,
  },
  { name: 'a user may take ownership', ace: ' 0: user:kirill allow chown', foreignWrite: true },
  {
    name: 'write is not the first right listed',
    ace: ' 2: user:kirill allow read,execute,write',
    foreignWrite: true,
  },
  // Over-matched on purpose: an attribute write is refused too, which errs on the safe side.
  { name: 'a user may write attributes', ace: ' 0: user:kirill allow read,writeattr', foreignWrite: true },
  {
    name: 'a user whose name only starts with root',
    ace: ' 0: user:rootkit allow write',
    foreignWrite: true,
  },
  {
    name: 'a group named root, which is not the user',
    ace: ' 0: group:root allow write',
    foreignWrite: true,
  },
  {
    name: 'a user may only read and execute',
    ace: ' 0: user:kirill allow read,execute',
    foreignWrite: false,
  },
  { name: 'everyone is denied write', ace: ' 0: group:everyone deny write,delete', foreignWrite: false },
  {
    name: 'root may write, as it can anyway',
    ace: ' 1: user:root allow write,append,delete',
    foreignWrite: false,
  },
];
