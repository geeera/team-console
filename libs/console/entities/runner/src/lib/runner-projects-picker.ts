import { booleanAttribute, ChangeDetectionStrategy, Component, input, model } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { CheckRow, List } from '@console/shared/ui';

/** A project a runner may be allowed to serve, as the picker lists it. */
export interface RunnerProjectOption {
  readonly slug: string;
  readonly displayName: string;
}

/**
 * The projects a runner may claim jobs for (#464, `allowed_projects`): one checkbox row per active project of the
 * account, used by enrolment and by the allow-list editor. A slug the runner holds that is no longer listed (an
 * archived project) is kept in `selected` untouched — the Worker refuses it on save, and the owner sees why.
 */
@Component({
  selector: 'tc-runner-projects-picker',
  imports: [CheckRow, List, TranslocoPipe],
  template: `
    <fieldset class="runner-projects">
      <legend class="runner-projects__legend">{{ legend() }}</legend>
      @if (projects().length === 0) {
        <p class="runner-projects__empty" data-testid="runner-projects-empty">{{ 'runners.projects.none' | transloco }}</p>
      } @else {
        <tc-list>
          @for (project of projects(); track project.slug) {
            <tc-check-row
              data-testid="runner-project-option"
              [attr.data-slug]="project.slug"
              [checked]="selected().includes(project.slug)"
              [disabled]="disabled()"
              (checkedChange)="toggle(project.slug, $event)"
            >
              <span tc-check-title dir="auto">{{ project.displayName }}</span>
              <span tc-check-detail>{{ project.slug }}</span>
            </tc-check-row>
          }
        </tc-list>
      }
      <p class="runner-projects__hint">{{ 'runners.projects.hint' | transloco }}</p>
    </fieldset>
  `,
  styles: `
    .runner-projects {
      display: grid;
      gap: var(--space-2);
      margin: 0;
      padding: 0;
      border: 0;
      min-width: 0;
    }

    .runner-projects__legend {
      padding: 0;
      font-weight: var(--fw-semibold);
    }

    .runner-projects__empty,
    .runner-projects__hint {
      margin: 0;
      font-size: var(--fs-sm);
      color: var(--text-2);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RunnerProjectsPicker {
  /** Already translated. */
  readonly legend = input.required<string>();
  readonly projects = input.required<readonly RunnerProjectOption[]>();
  readonly selected = model<readonly string[]>([]);
  readonly disabled = input(false, { transform: booleanAttribute });

  protected toggle(slug: string, checked: boolean): void {
    this.selected.update((current) =>
      checked ? (current.includes(slug) ? current : [...current, slug]) : current.filter((entry) => entry !== slug),
    );
  }
}
