import { env } from 'cloudflare:test';
import { TrackerProjectsRepo } from '../lib/tracker/tracker-projects.repo';
import type { TrackerActor } from '../lib/tracker/item-events.repo';

/** Test-only. Tracker rows are append-only and reference their project, so each case takes a fresh project. */

export const OWNER_ACTOR: TrackerActor = { kind: 'owner', name: 'owner', jobId: null };
export const AT = '2026-11-04T10:00:00.000Z';

let counter = 0;

/** A new project on GitHub Issues (`tracker = 'github'`), with a slug no other case uses. */
export async function seedGitHubProject(): Promise<string> {
  counter += 1;
  const slug = `p${String(counter)}-${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare(
    'INSERT INTO projects (slug, repo, display_name, cache_epoch, added_at) VALUES (?1, ?2, ?3, 0, ?4)',
  )
    .bind(slug, `acme/${slug}`, slug, AT)
    .run();
  return slug;
}

/** A new project on the console's tracker with its builtin labels; the prefix is unique per environment. */
export async function seedTrackerProject(nextItemNumber = 1): Promise<{ slug: string; keyPrefix: string }> {
  const slug = await seedGitHubProject();
  const keyPrefix = `T${String.fromCharCode(65 + (counter % 26))}${String.fromCharCode(65 + Math.floor(counter / 26))}`;
  await new TrackerProjectsRepo(env.DB).switchTracker(slug, {
    tracker: 'console',
    keyPrefix,
    nextItemNumber,
    at: AT,
  });
  return { slug, keyPrefix };
}
