import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { SwPush } from '@angular/service-worker';
import { Subject } from 'rxjs';
import { PushTaps, tappedUrlOf } from './push-taps';

@Component({ template: '' })
class Blank {}

function click(url: unknown) {
  return {
    action: '',
    notification: {
      title: 'storify · your answer is needed',
      data: { onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url } } },
    },
  };
}

describe('PushTaps', () => {
  let clicks: Subject<unknown>;
  let router: Router;
  let stop: () => void;

  beforeEach(async () => {
    clicks = new Subject();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'needs-you', component: Blank },
          { path: 'settings', component: Blank },
          { path: 'p/:slug/questions', component: Blank },
        ]),
        { provide: SwPush, useValue: { isEnabled: true, notificationClicks: clicks } },
      ],
    });
    router = TestBed.inject(Router);
    await router.navigateByUrl('/settings');
    stop = TestBed.inject(PushTaps).start();
  });

  afterEach(() => stop());

  it('opens the tapped question in its project', async () => {
    clicks.next(click('/p/storify/questions#42'));
    await vi.waitFor(() => expect(router.url).toBe('/p/storify/questions#42'));
  });

  it('opens Needs you for the test notification', async () => {
    clicks.next(click('/needs-you'));
    await vi.waitFor(() => expect(router.url).toBe('/needs-you'));
  });

  it('ignores a target that is not one of the Worker’s', async () => {
    const navigate = vi.spyOn(router, 'navigateByUrl');
    clicks.next(click('https://evil.example/needs-you'));
    clicks.next(click('/p/storify/questions#<img>'));
    clicks.next({ action: '', notification: { title: 'no data' } });
    await Promise.resolve();
    expect(navigate).not.toHaveBeenCalled();
    expect(router.url).toBe('/settings');
  });
});

describe('tappedUrlOf', () => {
  it('reads the default action’s url and nothing else', () => {
    expect(tappedUrlOf(click('/needs-you'))).toBe('/needs-you');
    expect(tappedUrlOf({ notification: { data: { url: '/needs-you' } } })).toBeUndefined();
    expect(tappedUrlOf(null)).toBeUndefined();
  });
});
