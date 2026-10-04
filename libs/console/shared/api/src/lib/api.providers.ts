import { HttpInterceptorFn, provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { EnvironmentProviders } from '@angular/core';
import { accessSessionInterceptor } from './access-session.interceptor';

/** Interceptor chain for every console request; #9 adds the DTO clients without touching `apps/console`. */
export const consoleInterceptors: readonly HttpInterceptorFn[] = [accessSessionInterceptor];

export function provideConsoleApi(): EnvironmentProviders {
  return provideHttpClient(withFetch(), withInterceptors([...consoleInterceptors]));
}
