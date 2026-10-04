import { inject, type Signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, NavigationEnd, Router } from '@angular/router';
import { filter, map } from 'rxjs';
import { questionNumberOf } from './push-target';

/** One arrival at `/p/{slug}/questions#n`; `id` tells two taps on the same item apart. */
export interface QuestionArrival {
  readonly number: number;
  readonly id: number;
}

let nextArrivalId = 0;

/**
 * The item a notification tap (or a typed `#n`) asks the questions screen to show, per finished navigation: the
 * same URL tapped again is a new arrival. The fragment counts only as digits; anything else is no arrival.
 * Call in an injection context of a component under the questions route.
 */
export function injectQuestionArrival(): Signal<QuestionArrival | null> {
  const router = inject(Router);
  const route = inject(ActivatedRoute);
  const arrivalOf = (): QuestionArrival | null => {
    const number = questionNumberOf(route.snapshot.fragment);
    return number === null ? null : { number, id: ++nextArrivalId };
  };
  // The component is created inside a navigation; that navigation's end is its first reading.
  const initial = router.currentNavigation() === null ? arrivalOf() : null;
  return toSignal(
    router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map(() => arrivalOf()),
    ),
    { initialValue: initial },
  );
}
