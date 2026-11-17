import { LiveAnnouncer } from '@angular/cdk/a11y';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { NetworkStatus } from '@console/shared/api';
import {
  LocalDayPipe,
  localUsdOf,
  pluralKeyOf,
  TranslocoPipe,
  TranslocoPluralPipe,
  TranslocoService,
} from '@console/shared/i18n';
import {
  Banner,
  Button,
  Callout,
  Chip,
  Icon,
  isPhoneSignal,
  Segment,
  SegmentedRadio,
  Sheet,
  StateBlock,
  Switch,
  Toaster,
} from '@console/shared/ui';
import {
  CAP_MODES,
  GATE_POLICIES,
  REVIEWER_CONTEXTS,
  SUGGESTED_MONTHLY_BUDGET_USD,
  TEAM_CONFIG_BOUNDS,
  TEAM_CONFIG_PRESETS,
  TEAM_CONFIG_PRESET_ROLES,
  TEAM_LANGUAGES,
  TEAM_ROLES,
  type AccessSource as Source,
  type CapMode,
  type TeamConfigPreset,
  type TeamRole,
} from '@shared/contracts';
import { firstValueFrom } from 'rxjs';
import { AccessSource } from '../access-source/access-source';
import { ChangesTable, type ChangeRow } from '../changes-table/changes-table';
import { RoleRow } from '../role-row/role-row';
import { SaveBar } from '../save-bar/save-bar';
import { ModelPickerSheet, type ModelPick, type ModelPickerData } from '../sheets/model-picker-sheet';
import { ReviewSheet, type ReviewOutcome, type ReviewSheetData } from '../sheets/review-sheet';
import { RoleLimitsSheet, type RoleLimits } from '../sheets/role-limits-sheet';
import { SubscriptionSheet } from '../sheets/subscription-sheet';
import { TeamConfigStore, type FieldError } from '../team-config.store';
import { modelsChangedBy, overriddenRolesOf, overridesOf, resetRole, withLeaf, withPreset, type DraftChange } from '../team-draft';
import { controlPathOf, sectionOf, type TeamSectionName } from '../team-fields';
import { fieldLabelOf, valueTextOf } from '../team-words';
import { NumberField } from './number-field';
import { TeamSection } from './team-section';

/** "{n} unsaved changes" is announced once the owner pauses, not on every keystroke (UX spec §6). */
const ANNOUNCE_DEBOUNCE_MS = 700;

/**
 * Settings › Team (#688; UX spec on #630; ADR 0009): the owner switches roles, picks models, sets limits, the access
 * source and the rules, then reviews and saves them as one revision. Nothing saves on change. A member sees every
 * value as text and the read-only banner, never a control or the save bar; the owner signal is the Worker's
 * (`canManage`), and every write is checked again there. Every value, reason and author name is interpolated text,
 * never HTML (threat model T4).
 */
@Component({
  selector: 'tc-team-config-editor',
  imports: [
    AccessSource,
    Banner,
    Button,
    Callout,
    ChangesTable,
    Chip,
    FormsModule,
    Icon,
    LocalDayPipe,
    NumberField,
    RoleRow,
    SaveBar,
    Segment,
    SegmentedRadio,
    StateBlock,
    Switch,
    TeamSection,
    TranslocoPipe,
    TranslocoPluralPipe,
  ],
  templateUrl: './team-config-editor.html',
  styleUrl: './team-config-editor.css',
  providers: [TeamConfigStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TeamConfigEditor {
  protected readonly store = inject(TeamConfigStore);
  private readonly sheet = inject(Sheet);
  private readonly toaster = inject(Toaster);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly transloco = inject(TranslocoService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  private readonly bannerHeading = viewChild<ElementRef<HTMLElement>>('bannerHeading');

  readonly slug = input.required<string>();

  protected readonly online = inject(NetworkStatus).online;
  protected readonly isPhone = isPhoneSignal();
  protected readonly lang = toSignal(this.transloco.langChanges$, { initialValue: this.transloco.getActiveLang() });

  protected readonly roles = TEAM_ROLES;
  protected readonly presets = TEAM_CONFIG_PRESETS;
  protected readonly gatePolicies = GATE_POLICIES;
  protected readonly gates = ['qa', 'reviewer'] as const;
  protected readonly languages = TEAM_LANGUAGES;
  protected readonly contexts = REVIEWER_CONTEXTS;
  protected readonly capModes = CAP_MODES;
  protected readonly bounds = TEAM_CONFIG_BOUNDS;

  /** Phone folding (owner, 2026-11-17): Preset and Roles start open, Access, Limits and Rules folded. */
  protected readonly open = {
    preset: signal(true),
    access: signal(false),
    roles: signal(true),
    limits: signal(false),
    rules: signal(false),
  } satisfies Record<TeamSectionName, unknown>;
  /** Paths whose typed text is out of range: the review waits until they are fixed. */
  protected readonly typedInvalid = signal<ReadonlySet<string>>(new Set());
  protected readonly epoch = signal(0);
  protected readonly showTheirs = signal(false);

  protected readonly view = this.store.view;
  protected readonly draft = this.store.draft;
  protected readonly readOnly = computed(() => !this.store.canEdit());
  protected readonly overridden = computed(() => {
    const draft = this.draft();
    return draft === null ? [] : overriddenRolesOf(draft);
  });
  protected readonly rolesOn = computed(() => {
    const draft = this.draft();
    return draft === null ? 0 : TEAM_ROLES.filter((role) => draft.roles[role].enabled).length;
  });
  protected readonly isSubscription = computed(() => this.draft()?.source === 'subscription');
  protected readonly author = computed(() => this.view()?.updatedByName ?? this.t('teamConfig.owner'));
  protected readonly suggestedUsd = computed(() => {
    const draft = this.draft();
    const usd = draft === null ? null : SUGGESTED_MONTHLY_BUDGET_USD[draft.preset];
    return usd === null ? null : localUsdOf(usd, this.lang());
  });
  protected readonly budgetSummary = computed(() => {
    const usd = this.draft()?.monthlyUsd ?? null;
    return usd === null ? this.t('teamConfig.value.noBudget') : this.t('teamConfig.limits.perMonth', { usd: localUsdOf(usd, this.lang()) });
  });
  protected readonly rulesSummary = computed(() => {
    const draft = this.draft();
    return draft === null ? '' : `${this.t('teamConfig.rules.gate.qa')}: ${valueTextOf(this.t, this.lang(), 'gates.qa', draft.gates.qa)}`;
  });
  /** Why "Review and save" cannot open now; `null` when it can. */
  protected readonly reviewOffReason = computed((): string | null => {
    this.lang();
    if (!this.online()) {
      return this.t('teamConfig.bar.offline');
    }
    if (this.typedInvalid().size > 0) {
      return this.t('teamConfig.bar.invalid');
    }
    return this.store.isDirty() ? null : this.t('teamConfig.bar.nothing');
  });
  protected readonly showBar = computed(() => !this.readOnly() && (this.store.isDirty() || this.typedInvalid().size > 0));
  protected readonly theirChangeRows = computed(() => this.rowsOf(this.store.theirChanges()));

  constructor() {
    effect(() => {
      const slug = this.slug();
      void untracked(() => this.store.load(slug));
    });
    this.announceChanges();
    this.guardUnload();
  }

  /** For the page's leave guard: unsaved edits ask "Leave without saving?" first (UX spec §4). */
  async confirmLeave(): Promise<boolean> {
    const count = this.store.changes().length;
    if (count === 0 || this.readOnly()) {
      return true;
    }
    return this.sheet.confirm({
      title: this.t('teamConfig.leave.title'),
      message: this.plural('teamConfig.leave.body', count),
      confirmLabel: this.t('teamConfig.leave.go'),
      cancelLabel: this.t('teamConfig.leave.stay'),
      tone: 'danger',
    });
  }

  protected reload(): void {
    void this.store.load(this.slug());
  }

  // ── Preset ────────────────────────────────────────────────────────────────────────────────────────────────

  /** A radio never checks itself here: the confirm decides, then the draft redraws the group. */
  protected async choosePreset(preset: TeamConfigPreset, event: Event): Promise<void> {
    event.preventDefault();
    const draft = this.draft();
    if (draft === null || draft.preset === preset || this.readOnly()) {
      return;
    }
    const overrides = overriddenRolesOf(draft).length;
    const isConfirmed = await this.sheet.confirm({
      title: this.t('teamConfig.preset.confirmTitle', { preset: this.t(`teamConfig.preset.${preset}`) }),
      message: this.t('teamConfig.preset.confirmModels', { n: modelsChangedBy(draft, preset) }),
      ...(overrides > 0 ? { note: this.t('teamConfig.preset.confirmOverrides', { n: overrides }) } : {}),
      confirmLabel: this.t('teamConfig.preset.confirmOk'),
      cancelLabel: this.t('teamConfig.common.cancel'),
    });
    if (isConfirmed) {
      this.store.replace(withPreset(draft, preset));
    }
  }

  protected resetToPreset(): void {
    const draft = this.draft();
    if (draft !== null) {
      this.store.replace(withPreset(draft, draft.preset));
      this.announce(this.t('teamConfig.preset.resetDone', { preset: this.t(`teamConfig.preset.${draft.preset}`) }));
    }
  }

  // ── Access ────────────────────────────────────────────────────────────────────────────────────────────────

  protected async chooseSource(source: Source): Promise<void> {
    const view = this.view();
    if (view === null || this.readOnly()) {
      return;
    }
    if (source === 'api_key') {
      this.store.edit('access.source', source);
      return;
    }
    if (view.subscriptionBlocked) {
      this.announce(this.t('teamConfig.access.blocked'));
      return;
    }
    const ref = this.sheet.open<boolean>(SubscriptionSheet, { title: this.t('teamConfig.access.confirmTitle'), role: 'alertdialog' });
    if ((await firstValueFrom(ref.closed)) === true) {
      this.store.edit('access.source', 'subscription');
    }
  }

  // ── Roles ─────────────────────────────────────────────────────────────────────────────────────────────────

  protected toggleRole(role: TeamRole, enabled: boolean): void {
    this.store.edit(`roles.${role}.enabled`, enabled);
  }

  protected async pickModel(role: TeamRole): Promise<void> {
    const draft = this.draft();
    if (draft === null) {
      return;
    }
    const settings = draft.roles[role];
    const data: ModelPickerData = {
      role,
      model: settings.model,
      effort: settings.effort,
      preset: draft.preset,
      presetModel: TEAM_CONFIG_PRESET_ROLES[draft.preset][role].model,
    };
    const ref = this.sheet.open<ModelPick, ModelPickerData>(ModelPickerSheet, {
      title: this.t('teamConfig.picker.title', { role: this.t(`teamConfig.role.name.${role}`) }),
      data,
    });
    const pick = await firstValueFrom(ref.closed);
    const now = this.draft();
    if (pick !== undefined && now !== null) {
      const paths = [`roles.${role}.model`, `roles.${role}.effort`];
      this.store.replace(withLeaf(withLeaf(now, paths[0] as string, pick.model), paths[1] as string, pick.effort), paths);
    }
  }

  protected async editLimits(role: TeamRole): Promise<void> {
    const draft = this.draft();
    if (draft === null) {
      return;
    }
    const { max_minutes, max_turns, max_parallel } = draft.roles[role];
    const ref = this.sheet.open<RoleLimits, RoleLimits>(RoleLimitsSheet, {
      title: this.t('teamConfig.limits.title', { role: this.t(`teamConfig.role.name.${role}`) }),
      data: { max_minutes, max_turns, max_parallel },
    });
    const limits = await firstValueFrom(ref.closed);
    let now = this.draft();
    if (limits === undefined || now === null) {
      return;
    }
    const paths = (['max_minutes', 'max_turns', 'max_parallel'] as const).map((key) => {
      now = withLeaf(now as NonNullable<typeof now>, `roles.${role}.${key}`, limits[key]);
      return `roles.${role}.${key}`;
    });
    this.store.replace(now, paths);
  }

  protected resetRole(role: TeamRole): void {
    const draft = this.draft();
    if (draft !== null) {
      this.store.replace(resetRole(draft, role), [`roles.${role}.model`, `roles.${role}.effort`]);
      this.focusControl(`roles.${role}.model`);
    }
  }

  protected isOverridden(role: TeamRole): boolean {
    const draft = this.draft();
    return draft !== null && overridesOf(draft, role).length > 0;
  }

  // ── Values ────────────────────────────────────────────────────────────────────────────────────────────────

  protected edit(path: string, value: unknown): void {
    this.store.edit(path, value);
  }

  protected markTyped(path: string, isInvalid: boolean): void {
    const next = new Set(this.typedInvalid());
    if (isInvalid) {
      next.add(path);
    } else {
      next.delete(path);
    }
    this.typedInvalid.set(next);
  }

  protected removeCodePath(index: number): void {
    const draft = this.draft();
    if (draft === null) {
      return;
    }
    if (draft.gates.code_paths.length <= TEAM_CONFIG_BOUNDS.codePaths.min) {
      this.store.setError('gates.code_paths', { key: 'teamConfig.rules.paths.lastOne' });
      return;
    }
    this.store.edit('gates.code_paths', draft.gates.code_paths.filter((_, at) => at !== index));
  }

  protected addCodePath(input: HTMLInputElement): void {
    const draft = this.draft();
    const glob = input.value.trim();
    if (draft === null || glob === '') {
      return;
    }
    const { codePaths, codePathLength } = TEAM_CONFIG_BOUNDS;
    const isValid =
      glob.length <= codePathLength.max && !glob.includes('..') && !glob.startsWith('/') && !glob.includes('\\');
    if (!isValid) {
      this.store.setError('gates.code_paths', { key: 'teamConfig.rules.paths.invalid', params: { max: codePathLength.max } });
      return;
    }
    if (draft.gates.code_paths.length >= codePaths.max) {
      this.store.setError('gates.code_paths', { key: 'teamConfig.rules.paths.tooMany', params: { max: codePaths.max } });
      return;
    }
    if (!draft.gates.code_paths.includes(glob)) {
      this.store.edit('gates.code_paths', [...draft.gates.code_paths, glob]);
    }
    input.value = '';
  }

  /** The inline error of a control: its own, or a 422 on any document path that lands on it. */
  protected errorOf(control: string): string | null {
    for (const [path, error] of this.store.errors()) {
      if (controlPathOf(path) === control) {
        return this.word(error, path);
      }
    }
    return null;
  }

  protected word(error: FieldError, path?: string): string {
    this.lang();
    const why = this.t(error.key, { ...error.params });
    return path === undefined || error.key !== 'teamConfig.error.invalid'
      ? why
      : this.t('teamConfig.error.field', { field: fieldLabelOf(this.t, path) });
  }

  // ── Save ──────────────────────────────────────────────────────────────────────────────────────────────────

  protected discard(): void {
    this.store.discard();
    this.typedInvalid.set(new Set());
    this.epoch.update((epoch) => epoch + 1);
    this.focusSelector('[data-testid="preset-group"] input:checked');
  }

  protected async review(): Promise<void> {
    if (this.reviewOffReason() !== null) {
      return;
    }
    let after: (() => void) | null = null;
    const data: ReviewSheetData = {
      rows: this.rowsOf(this.store.changes()),
      save: async (reason: string): Promise<ReviewOutcome> => {
        const result = await this.store.save(reason);
        switch (result.kind) {
          case 'saved':
            after = () => this.saved(result.view.revision);
            return 'close';
          case 'invalid':
            after = () => this.focusError(result.field);
            return 'close';
          case 'hosted':
            after = () => this.focusError('access.source');
            return 'close';
          case 'stale':
          case 'forbidden':
            after = () => this.focusBanner();
            return 'close';
          case 'failed':
            this.announce(this.t('teamConfig.review.failed'));
            return 'retry';
        }
      },
    };
    const ref = this.sheet.open<boolean, ReviewSheetData>(ReviewSheet, {
      title: this.t('teamConfig.review.title'),
      data,
      width: 'wide',
    });
    await firstValueFrom(ref.closed);
    (after as (() => void) | null)?.();
  }

  // ── Conflict ──────────────────────────────────────────────────────────────────────────────────────────────

  protected keepMine(): void {
    const conflicts = this.store.keepMine();
    this.showTheirs.set(false);
    this.announce(
      conflicts.length === 0
        ? this.t('teamConfig.conflict.mergedClean', { n: this.view()?.revision ?? 0 })
        : this.t('teamConfig.conflict.mergedTitle', { n: this.view()?.revision ?? 0 }),
    );
    if (conflicts.length > 0) {
      this.focusBanner();
    } else {
      this.focusSelector('[data-testid="save-bar-review"]');
    }
  }

  protected discardMine(): void {
    this.store.discardMine();
    this.showTheirs.set(false);
    this.typedInvalid.set(new Set());
    this.epoch.update((epoch) => epoch + 1);
    this.focusHeading();
  }

  protected takeTheirs(change: DraftChange): void {
    this.store.takeTheirs(change.path);
  }

  protected conflictOf(change: DraftChange): ChangeRow {
    return this.rowsOf([change])[0] as ChangeRow;
  }

  protected bannerAuthor(): string {
    const banner = this.store.banner();
    const name = banner !== null && banner.kind !== 'forbidden' ? banner.theirs.updatedByName : null;
    return name ?? this.t('teamConfig.owner');
  }

  protected bannerRevision(): number {
    const banner = this.store.banner();
    return banner !== null && banner.kind !== 'forbidden' ? banner.theirs.revision : 0;
  }

  // ── Words ─────────────────────────────────────────────────────────────────────────────────────────────────

  protected readonly t = (key: string, params?: Record<string, unknown>): string => this.transloco.translate(key, params);

  protected rowsOf(changes: readonly DraftChange[]): ChangeRow[] {
    const lang = this.lang();
    return changes.map((change) => ({
      path: change.path,
      label: fieldLabelOf(this.t, change.path),
      from: valueTextOf(this.t, lang, change.path, change.from),
      to: valueTextOf(this.t, lang, change.path, change.to),
    }));
  }

  protected valueText(path: string, value: unknown): string {
    return valueTextOf(this.t, this.lang(), path, value);
  }

  protected capLabel(mode: CapMode, key: 'dev_tasks' | 'parallel_devs'): string {
    return `${this.t(`teamConfig.rules.caps.${mode}`)}: ${this.t(`teamConfig.field.caps.${key}`)}`;
  }

  protected range(min: number, max: number): string {
    return this.t('teamConfig.limits.range', { min, max });
  }

  private plural(key: string, n: number): string {
    return this.t(pluralKeyOf(key, this.lang(), n), { n });
  }

  // ── Focus and announcements ───────────────────────────────────────────────────────────────────────────────

  private saved(revision: number): void {
    const message = this.t('teamConfig.saved', { n: revision });
    this.toaster.show(message);
    this.announce(message);
    this.typedInvalid.set(new Set());
    this.focusHeading();
  }

  private focusError(path: string): void {
    const control = controlPathOf(path);
    this.open[sectionOf(control)].set(true);
    this.focusControl(control);
  }

  private focusControl(control: string): void {
    this.focusSelector(`[data-control="${control}"]`);
  }

  private focusSelector(selector: string): void {
    afterNextRender(
      () => {
        if (!this.sheet.hasOpen()) {
          this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus();
        }
      },
      { injector: this.injector },
    );
  }

  private focusHeading(): void {
    afterNextRender(() => this.heading()?.nativeElement.focus(), { injector: this.injector });
  }

  private focusBanner(): void {
    afterNextRender(() => this.bannerHeading()?.nativeElement.focus(), { injector: this.injector });
  }

  private announce(message: string): void {
    void this.announcer.announce(message, 'polite');
  }

  private announceChanges(): void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = 0;
    effect(() => {
      const count = this.store.changes().length;
      if (timer !== null) {
        clearTimeout(timer);
      }
      if (count === last) {
        return;
      }
      timer = setTimeout(() => {
        last = count;
        if (count > 0) {
          this.announce(this.plural('teamConfig.bar.announce', count));
        }
      }, ANNOUNCE_DEBOUNCE_MS);
    });
    inject(DestroyRef).onDestroy(() => {
      if (timer !== null) {
        clearTimeout(timer);
      }
    });
  }

  /** A reload or a closed tab with unsaved edits asks the browser's own question. */
  private guardUnload(): void {
    const view = this.host.nativeElement.ownerDocument.defaultView;
    const onUnload = (event: BeforeUnloadEvent): void => {
      if (this.store.isDirty() && !this.readOnly()) {
        event.preventDefault();
      }
    };
    view?.addEventListener('beforeunload', onUnload);
    inject(DestroyRef).onDestroy(() => view?.removeEventListener('beforeunload', onUnload));
  }
}
