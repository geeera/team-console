/**
 * Who a request to `/api/*` acts as, decided once by `authMiddleware` (ADR 0001 decision 7). Downstream code
 * reads `c.get('identity')` and never looks at Access headers itself. Only `kind` is ever logged.
 */
export type Identity =
  | { readonly kind: 'user'; readonly email: string }
  | { readonly kind: 'service'; readonly commonName: string }
  | { readonly kind: 'local' };

declare module 'hono' {
  interface ContextVariableMap {
    identity: Identity;
  }
}
