import { HttpInterceptorFn, provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { EnvironmentProviders } from '@angular/core';

/**
 * Interceptor chain for every console request. Empty on purpose: #8 adds the
 * Access re-login interceptor and #9 the DTO clients without touching `apps/console`.
 */
export const consoleInterceptors: readonly HttpInterceptorFn[] = [];

export function provideConsoleApi(): EnvironmentProviders {
  return provideHttpClient(withFetch(), withInterceptors([...consoleInterceptors]));
}
