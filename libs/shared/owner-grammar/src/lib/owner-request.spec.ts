import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OwnerRequest } from '@shared/contracts';
import fixtures from '../../fixtures/owner-requests.json';
import { commandLines, isTeamNote } from './commands';
import {
  handledMarker,
  handledMarkerOf,
  requestComment,
  requestMarker,
  requestMarkerOf,
  type RequestLanguage,
} from './owner-request';

// Golden fixtures from the vendored plugin (fixtures/generate.py): the bytes the console writes, and what the
// plugin's `ptlib.ownerrequests` parsers and `commands` read from them and from hand-written marker lines.

const PLUGIN = resolve(import.meta.dirname, '../../../../..', '.claude/product-team');

interface ParsedRow {
  readonly body: string;
  readonly request: Record<string, string> | null;
  readonly handled: { comment_id: number; result: string } | null;
  readonly teamNote: boolean;
  readonly sameAccount: string[][];
  readonly app: string[][];
}

interface CommentRow extends ParsedRow {
  readonly language: string;
  readonly request: Record<string, string> | null;
  readonly ownerSaid: string;
}

const comments = fixtures.comments as unknown as readonly (CommentRow & { request: OwnerRequest })[];
const markers = fixtures.markers as unknown as readonly ParsedRow[];

function expectParsedLike(row: ParsedRow): void {
  expect(requestMarkerOf(row.body)).toEqual(row.request);
  const handled = handledMarkerOf(row.body);
  expect(handled === null ? null : { comment_id: handled.commentId, result: handled.result }).toEqual(
    row.handled,
  );
  expect(isTeamNote(row.body)).toBe(row.teamNote);
  const pairs = (sameAccount: boolean): string[][] =>
    commandLines(row.body, sameAccount).map((line) => [line.command, line.text]);
  expect(pairs(true)).toEqual(row.sameAccount);
  expect(pairs(false)).toEqual(row.app);
}

describe('owner-requests.json matches the vendored plugin', () => {
  it('was generated from the plugin as it is now (else: regenerate the fixtures)', () => {
    const manifest = JSON.parse(readFileSync(resolve(PLUGIN, '.claude-plugin/plugin.json'), 'utf8')) as {
      version: string;
    };
    expect(fixtures.plugin.version).toBe(manifest.version);
    for (const [path, digest] of Object.entries(fixtures.plugin.sources)) {
      const actual = createHash('sha256')
        .update(readFileSync(resolve(PLUGIN, path)))
        .digest('hex');
      expect({ path, digest: actual }).toEqual({ path, digest });
    }
  });
});

describe('requestComment', () => {
  it('covers every kind, target and direction in ru and en', () => {
    const seen = new Set(comments.map((row) => `${row.language} ${requestMarker(row.request)}`));
    expect(seen.size).toBe(10);
  });

  it.each(comments.map((row, index) => [index, row.language, row] as const))(
    '#%i (%s) writes the fixture bytes, which the plugin reads as the request and never as a command',
    (_, __, row) => {
      const body = requestComment({
        request: row.request,
        language: row.language as RequestLanguage,
        ownerSaid: row.ownerSaid,
      });
      expect(body).toBe(row.body);
      expect(body.startsWith('<!-- pt-')).toBe(true);
      expect(row.request).toEqual(requestMarkerOf(body));
      expect(row.sameAccount).toEqual([]);
      expect(row.app).toEqual([]);
      expectParsedLike(row);
    },
  );
});

describe('requestMarkerOf / handledMarkerOf against ptlib.ownerrequests', () => {
  it.each(markers.map((row, index) => [index, JSON.stringify(row.body).slice(0, 70), row] as const))(
    '#%i %s',
    (_, __, row) => {
      expectParsedLike(row);
    },
  );

  it('never reads one marker as the other', () => {
    const request = requestMarker({ kind: 'sprint', target: 'next' });
    const handled = handledMarker({ commentId: 123, result: 'applied' });
    expect(requestMarkerOf(handled)).toBeNull();
    expect(handledMarkerOf(request)).toBeNull();
    expect(handledMarkerOf(handled)).toEqual({ commentId: 123, result: 'applied' });
  });
});

describe('provenance (ADR 0005 decision 2), as the plugin evaluates it', () => {
  it('honours only an unedited owner request posted by the console app', () => {
    const outcome = Object.fromEntries(fixtures.provenance.map((row) => [row.name, row.pending]));
    expect(outcome).toEqual({
      'posted by the console app': true,
      'owner-authored, without performed_via_github_app': false,
      'another app': false,
      'edited after posting': false,
      'not the owner': false,
    });
  });

  it('every provenance case carries a body the console writes', () => {
    const body = requestComment({ request: { kind: 'sprint', target: 'next' }, language: 'ru' });
    expect(fixtures.provenance.every((row) => row.comment.body === body)).toBe(true);
  });
});
