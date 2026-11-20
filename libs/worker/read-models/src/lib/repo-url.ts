/** `https://github.com/<owner>/<repo>`, each part encoded: the one place a repository's page URL is built. */
export function repoUrlOf(repo: { readonly owner: string; readonly name: string }): string {
  return `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}
