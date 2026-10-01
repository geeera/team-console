import { spaceLocationOf } from '@console/entities/project';

export type ShellArea = 'space' | 'needs-you' | 'overview' | 'settings' | 'other';

/** Which part of the app a router URL shows, for the phone title and the sidebar's current marks. */
export function shellAreaOf(url: string): ShellArea {
  if (spaceLocationOf(url) !== null) {
    return 'space';
  }
  const path = url.split(/[?#]/, 1)[0] ?? '';
  if (path === '/needs-you' || path.startsWith('/needs-you/')) {
    return 'needs-you';
  }
  if (path === '/overview' || path.startsWith('/overview/')) {
    return 'overview';
  }
  if (path === '/settings' || path.startsWith('/settings/')) {
    return 'settings';
  }
  return 'other';
}
