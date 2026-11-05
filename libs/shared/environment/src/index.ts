// Whole files only (`export *`), never `export { … } from` (#123): a named re-export puts the whole file it points at
// into the importer's chunk, and `manifest.generated.ts` (the guide prose) must load only with the Environment setup
// pages. `status-dto.ts` has no manifest import, so a reader of the status alone never pulls the prose.
export * from './lib/manifest';
export * from './lib/manifest.generated';
export * from './lib/rows';
export * from './lib/status';
export * from './lib/status-dto';
