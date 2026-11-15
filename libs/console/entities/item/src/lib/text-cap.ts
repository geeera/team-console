/** The counter appears from this share of the cap (#107's rule). */
const COUNTER_FROM = 0.8;

/** A text against the API's cap, as the forms show it: the counter near the cap, how far over it is. */
export interface TextCap {
  /** In code points, as the server counts them. */
  readonly length: number;
  readonly max: number;
  readonly isCounted: boolean;
  /** `0` within the cap. */
  readonly overBy: number;
}

export function textCapOf(text: string, max: number): TextCap {
  const length = [...text].length;
  return { length, max, isCounted: length >= max * COUNTER_FROM, overBy: Math.max(0, length - max) };
}
