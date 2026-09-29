// The root ESLint config is plain JS; only the exported constraint tables are typed here.
declare module '../../../eslint.config.mjs' {
  export interface DepConstraint {
    sourceTag: string;
    onlyDependOnLibsWithTags: string[];
  }
  export const layerConstraints: DepConstraint[];
  export const scopeConstraints: DepConstraint[];
}
