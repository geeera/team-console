import { Hono } from 'hono';
import { isCommitSha, type DesignManifestDto } from '@shared/contracts';
import { problem, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import { imageMediaTypeOf } from '@worker/read-models';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import { findProject, projectNotFound, repoOf } from '../projects/lookup';
import { DesignReads } from '../read-models/design-reads';
import { ProjectReads } from '../read-models/project-reads';

// An issue number as GitHub assigns them; anything else is a 404 before D1 or GitHub is asked.
const ISSUE_NUMBER = /^[1-9][0-9]{0,8}$/;

/**
 * Every image answer (spec §R): the exact type, no sniffing, a CSP that lets the bytes do nothing even if a browser
 * ever treated them as a document, inline (never a download prompt on the phone), and cacheable for a year because
 * the URL pins the commit.
 */
export const DESIGN_FILE_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cache-Control': 'private, max-age=31536000, immutable',
};

/** A `filename` parameter from characters every user agent accepts; anything else becomes `_`. */
export function dispositionFileNameOf(file: string): string {
  const safe = file.replace(/[^A-Za-z0-9._-]/g, '_');
  return safe === '' ? 'design' : safe;
}

function designNotFound(c: WorkerContext<ApiEnv>): Response {
  return problem(c, { type: 'design-file-not-found', title: 'No such design file', status: 404 });
}

async function readsFor(c: WorkerContext<ApiEnv>, github: ApiGitHub): Promise<DesignReads | Response> {
  const project = await findProject(c, c.req.param('slug') ?? '');
  if (project === null) {
    return projectNotFound(c);
  }
  const repo = repoOf(c, project);
  if (repo instanceof Response) {
    return repo;
  }
  const reads = new ProjectReads(github, c.env, project, repo, github.now);
  return new DesignReads(github, c.env, project, repo, reads);
}

function issueOf(c: WorkerContext<ApiEnv>): number | null {
  const raw = c.req.param('issue') ?? '';
  return ISSUE_NUMBER.test(raw) ? Number(raw) : null;
}

/**
 * `GET /api/v1/projects/:slug/designs/:issue` and `…/designs/:issue/:sha/file?path=` (#277, spec §R). Reads only,
 * for the owner and the service identity alike, on the project's read-only installation token: the GitHub token
 * never reaches the client, so private repositories work. The slug, the issue number and the sha are checked before
 * D1 or GitHub is asked; the path must be a screen the manifest at that commit lists.
 */
export function createDesignRoutes(github: ApiGitHub): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .get('/:slug/designs/:issue', async (c) => {
      const issue = issueOf(c);
      if (issue === null) {
        return designNotFound(c);
      }
      const reads = await readsFor(c, github);
      if (reads instanceof Response) {
        return reads;
      }
      const manifest: DesignManifestDto = await reads.manifest(issue);
      return c.json(manifest);
    })
    .get('/:slug/designs/:issue/:sha/file', async (c) => {
      const issue = issueOf(c);
      const sha = c.req.param('sha') ?? '';
      if (issue === null || !isCommitSha(sha)) {
        return designNotFound(c);
      }
      const path = c.req.query('path');
      if (path === undefined || path === '') {
        return problem(c, { type: 'design-file-path-missing', title: 'path is required', status: 400 });
      }
      const reads = await readsFor(c, github);
      if (reads instanceof Response) {
        return reads;
      }
      const result = await reads.file(issue, sha, path);
      switch (result.kind) {
        case 'not-found':
          return designNotFound(c);
        case 'too-large':
          return problem(c, {
            type: 'design-file-too-large',
            title: 'The design file is larger than the console shows',
            status: 413,
          });
        case 'type-mismatch':
          return problem(c, {
            type: 'design-file-type-mismatch',
            title: 'The design file is not the image its name says',
            status: 415,
          });
        case 'bytes':
          return new Response(result.bytes, {
            status: 200,
            headers: {
              ...DESIGN_FILE_HEADERS,
              'Content-Type': imageMediaTypeOf(result.type),
              'Content-Length': String(result.bytes.byteLength),
              'Content-Disposition': `inline; filename="${dispositionFileNameOf(result.file)}"`,
            },
          });
      }
    });
}
