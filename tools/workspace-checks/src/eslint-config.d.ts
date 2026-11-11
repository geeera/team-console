// eslint.config.mjs is plain JS with no declaration file; TS only honours an ambient `declare
// module` for a relative specifier via a wildcard, not the literal relative path. This project
// imports only the root config, so the wildcard stays scoped to that one real import.
declare module '*/eslint.config.mjs' {
  export interface TagConstraint {
    readonly sourceTag: string;
    readonly onlyDependOnLibsWithTags: readonly string[];
  }
  export const layerConstraints: readonly TagConstraint[];
  export const scopeConstraints: readonly TagConstraint[];
}
