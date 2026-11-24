import { withoutInvisibles } from '@shared/plain-text';
import { findSecret, redactSecrets, type SecretKind } from './secrets';

// Judged as the reader sees it: no control or Default_Ignorable_Code_Point (ZWJ, variation selectors, CGJ, U+180E,
// fillers, tags …) inside a token hides it. Only the copy that is judged is stripped; the stored text is unchanged.
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const visibleText = (text: string): string => withoutInvisibles(text).replace(IGNORABLE, '');

/**
 * The one secret check for free text that is about to be stored (#462, #477): the kind of the first secret shape in
 * `text` as a reader sees it, or `null`. A job's tracker write is refused on it (422 `body-secret`), and the import
 * (#437) runs it on every imported title, body, comment and description before the row is written, refusing the
 * text or storing `maskSecretsInText(text).text` instead.
 */
export function findSecretInText(text: string): SecretKind | null {
  return findSecret(visibleText(text));
}

/** `maskSecretsInText`'s answer: the text to store and whether it differs from what came in. */
export interface MaskedText {
  readonly text: string;
  readonly masked: boolean;
}

/**
 * `text` with every secret shape replaced by `[redacted:<kind>]`, for a writer that stores untrusted text and cannot
 * refuse it (the import, #437). The result never matches `findSecretInText`: a token that only shows once the
 * invisible characters are gone is masked in the visible copy, which is then what is stored — losing the invisible
 * characters of that one text is the price of not keeping the token.
 */
export function maskSecretsInText(text: string): MaskedText {
  const direct = redactSecrets(text, 'strict');
  if (findSecretInText(direct) === null) {
    return { text: direct, masked: direct !== text };
  }
  return { text: redactSecrets(visibleText(text), 'strict'), masked: true };
}
