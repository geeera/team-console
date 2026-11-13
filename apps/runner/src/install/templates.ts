import { JOB_USER, RUNNER_USER } from '../backends/user';
import { RUNNER_HOME_ENV } from '../config/config';

/**
 * The files `install` writes (ADR 0008 decision 11). `apps/runner/launchd/*.plist` and `apps/runner/sudoers/*` are
 * these templates rendered with the documented defaults; `templates.spec.ts` keeps them identical.
 */

export const LAUNCH_LABEL = 'com.team-console.runner';
export const LAUNCH_DAEMON_PATH = `/Library/LaunchDaemons/${LAUNCH_LABEL}.plist`;
export const SUDOERS_PATH = '/etc/sudoers.d/team-console-runner';
export const SYSTEMD_UNIT_NAME = 'team-console-runner.service';

/** A path every template may hold unquoted: absolute, no space, no character sudoers or XML would read. */
export const SAFE_PATH = /^\/[A-Za-z0-9._/-]{1,200}$/;

export interface ServiceFiles {
  /** The `node` the service runs (`process.execPath` at install). */
  readonly node: string;
  /** The directory holding `team-console-runner.mjs` and `bin/job-exec`. */
  readonly prefix: string;
  readonly home: string;
}

export const DOCUMENTED_DEFAULTS: ServiceFiles = {
  node: '/opt/homebrew/bin/node',
  prefix: '/usr/local/lib/team-console-runner',
  home: '/Users/_tcrunner',
};

export const jobExecOf = (prefix: string): string => `${prefix}/bin/job-exec`;
export const bundleOf = (prefix: string): string => `${prefix}/team-console-runner.mjs`;
const dirOf = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/';

/** The one rule (threat model L3): `_tcrunner` may run `job-exec` as `_tcjob`, nothing else, with no password. */
export function sudoersRule(prefix: string): string {
  return [
    '# team-console-runner (ADR 0008 decision 11): the runner may start the job-exec wrapper as the job user; nothing',
    '# else. No pty, so the launch spec on stdin reaches job-exec and its output streams back to the runner.',
    `Defaults:${RUNNER_USER} !use_pty, !lecture`,
    `${RUNNER_USER} ALL=(${JOB_USER}) NOPASSWD: ${jobExecOf(prefix)}`,
    '',
  ].join('\n');
}

function plist(entries: readonly string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    ...entries.map((line) => `  ${line}`),
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function serviceEntries(files: ServiceFiles, umask: number): string[] {
  const path = `${dirOf(files.node)}:/usr/bin:/bin:/usr/sbin:/sbin`;
  return [
    `<key>Label</key><string>${LAUNCH_LABEL}</string>`,
    '<key>ProgramArguments</key>',
    '<array>',
    `  <string>${files.node}</string>`,
    `  <string>${bundleOf(files.prefix)}</string>`,
    '  <string>run</string>',
    '  <string>--loop</string>',
    '</array>',
    '<key>EnvironmentVariables</key>',
    '<dict>',
    `  <key>${RUNNER_HOME_ENV}</key><string>${files.home}</string>`,
    `  <key>HOME</key><string>${files.home}</string>`,
    `  <key>PATH</key><string>${path}</string>`,
    '</dict>',
    `<key>WorkingDirectory</key><string>${files.home}</string>`,
    `<key>Umask</key><integer>${String(umask)}</integer>`,
    '<key>RunAtLoad</key><true/>',
    '<key>KeepAlive</key><true/>',
    '<key>ThrottleInterval</key><integer>30</integer>',
    `<key>StandardOutPath</key><string>${files.home}/logs/runner.log</string>`,
    `<key>StandardErrorPath</key><string>${files.home}/logs/runner.log</string>`,
  ];
}

/**
 * The `user` backend's LaunchDaemon: the runner as `_tcrunner`, umask 027 so the mirror it fetches is readable by
 * the job group and by no one else.
 */
export function launchDaemonPlist(files: ServiceFiles): string {
  return plist([
    ...serviceEntries(files, 0o027),
    `<key>UserName</key><string>${RUNNER_USER}</string>`,
    `<key>GroupName</key><string>${JOB_USER}</string>`,
  ]);
}

/** The `container` backend's LaunchAgent (macOS): the runner as the logged-in user. */
export function launchAgentPlist(files: ServiceFiles): string {
  return plist(serviceEntries(files, 0o077));
}

/** The `container` backend's systemd user unit (Linux). */
export function systemdUnit(files: ServiceFiles): string {
  return [
    '[Unit]',
    'Description=team-console runner (container backend)',
    'After=network-online.target',
    '',
    '[Service]',
    `Environment=${RUNNER_HOME_ENV}=${files.home}`,
    `ExecStart=${files.node} ${bundleOf(files.prefix)} run --loop`,
    'UMask=0077',
    'Restart=always',
    'RestartSec=30',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}
