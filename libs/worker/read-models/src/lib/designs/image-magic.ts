import type { DesignImageType } from '@shared/contracts';

/**
 * The image format the first bytes announce (#277, spec §R): the Worker serves a design file only when this agrees
 * with the type its name claims, so a file renamed to `.png` that is really something else is never sent as an image.
 */

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

/** How many leading bytes `imageTypeOfBytes` needs at most. */
export const IMAGE_MAGIC_LENGTH = 12;

function startsWith(bytes: Uint8Array, magic: readonly number[], offset = 0): boolean {
  if (bytes.byteLength < offset + magic.length) {
    return false;
  }
  return magic.every((byte, index) => bytes[offset + index] === byte);
}

export function imageTypeOfBytes(bytes: Uint8Array): DesignImageType | null {
  if (startsWith(bytes, PNG)) {
    return 'png';
  }
  if (startsWith(bytes, JPEG)) {
    return 'jpeg';
  }
  if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) {
    return 'gif';
  }
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) {
    return 'webp';
  }
  return null;
}

const MEDIA_TYPES: Readonly<Record<DesignImageType, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** The exact `Content-Type` of a served design image. */
export function imageMediaTypeOf(type: DesignImageType): string {
  return MEDIA_TYPES[type];
}
