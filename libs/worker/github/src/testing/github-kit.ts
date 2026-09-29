import type { FetchLike } from '../lib/transport';

/** Test-only helpers: a generated app key (never a real credential) and a scripted api.github.com. */

export interface AppKey {
  readonly pem: string;
  readonly publicKey: CryptoKey;
}

function base64Of(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export async function generateAppKey(): Promise<AppKey> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const der = base64Of((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  const lines = der.match(/.{1,64}/g) ?? [];
  return {
    pem: `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`,
    publicKey: pair.publicKey,
  };
}

function bytesOfBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

export interface DecodedJwt {
  readonly header: Record<string, unknown>;
  readonly claims: Record<string, unknown>;
  readonly signatureValid: boolean;
}

export async function decodeJwt(jwt: string, publicKey: CryptoKey): Promise<DecodedJwt> {
  const [header = '', claims = '', signature = ''] = jwt.split('.');
  const decode = (part: string) =>
    JSON.parse(new TextDecoder().decode(bytesOfBase64Url(part))) as Record<string, unknown>;
  return {
    header: decode(header),
    claims: decode(claims),
    signatureValid: await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      bytesOfBase64Url(signature),
      new TextEncoder().encode(`${header}.${claims}`),
    ),
  };
}

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | undefined;
  readonly redirect: RequestRedirect | undefined;
}

export type Handler = (call: RecordedCall) => Response | Promise<Response>;

export interface ScriptedGitHub {
  readonly fetch: FetchLike;
  readonly calls: RecordedCall[];
}

/** Records every request and answers through `handler`; it throws for anything the handler does not expect. */
export function scriptedGitHub(handler: Handler): ScriptedGitHub {
  const calls: RecordedCall[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      const call: RecordedCall = {
        url: input,
        method: init.method ?? 'GET',
        headers: new Headers(init.headers),
        body: typeof init.body === 'string' ? init.body : undefined,
        redirect: init.redirect,
      };
      calls.push(call);
      return handler(call);
    },
  };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export const INSTALLATION_ID = 4242;
export const SENTINEL_TOKEN = 'ghs_TESTSENTINEL0123456789';

/**
 * The happy path of the app flow for `owner/name`: installation lookup, mint (tokens numbered so tests can
 * tell a re-mint), and whatever `read` answers for any other call.
 */
export function appFlow(
  read: Handler,
  options: { tokenPrefix?: string } = {},
): ScriptedGitHub & { minted: () => number } {
  let minted = 0;
  const github = scriptedGitHub(async (call) => {
    const path = new URL(call.url).pathname;
    if (call.method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/installation$/.test(path)) {
      return json(200, { id: INSTALLATION_ID });
    }
    if (call.method === 'GET' && path === '/app') {
      return json(200, { id: 1, slug: 'team-console-test' });
    }
    if (call.method === 'POST' && path === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
      minted += 1;
      return json(201, {
        token: `${options.tokenPrefix ?? SENTINEL_TOKEN}${minted}`,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
    }
    return read(call);
  });
  return { ...github, minted: () => minted };
}
