/** The Settings › Team page of a project (#688), for the links to it. */
export function teamSettingsUrlOf(slug: string): string {
  return `/settings/projects/${encodeURIComponent(slug)}/team`;
}
