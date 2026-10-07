import { IMAGE_MAGIC_LENGTH, imageMediaTypeOf, imageTypeOfBytes } from './image-magic';

const bytes = (...values: (number | string)[]): Uint8Array =>
  Uint8Array.from(
    values.flatMap((value) => (typeof value === 'string' ? [...value].map((c) => c.charCodeAt(0)) : [value])),
  );

describe('imageTypeOfBytes', () => {
  it.each([
    ['png', bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 'IHDR')],
    ['jpeg', bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16, 'JFIF')],
    ['gif', bytes('GIF89a', 1, 0, 1, 0)],
    ['gif', bytes('GIF87a', 1, 0, 1, 0)],
    ['webp', bytes('RIFF', 0x24, 0, 0, 0, 'WEBPVP8 ')],
  ] as const)('recognises %s', (type, leading) => {
    expect(imageTypeOfBytes(leading)).toBe(type);
  });

  it.each([
    ['an SVG', bytes('<svg xmlns="http://www.w3.org/2000/svg">')],
    ['HTML', bytes('<!doctype html><html>')],
    ['a RIFF that is not WEBP (WAVE)', bytes('RIFF', 0x24, 0, 0, 0, 'WAVEfmt ')],
    ['a truncated PNG header', bytes(0x89, 'PNG', 0x0d)],
    ['an empty body', bytes()],
    ['a BMP', bytes('BM', 0, 0, 0, 0)],
  ] as const)('refuses %s', (_label, leading) => {
    expect(imageTypeOfBytes(leading)).toBeNull();
  });

  it('needs no more than the declared number of leading bytes', () => {
    const webp = bytes('RIFF', 0x24, 0, 0, 0, 'WEBP');
    expect(webp.byteLength).toBe(IMAGE_MAGIC_LENGTH);
    expect(imageTypeOfBytes(webp)).toBe('webp');
  });
});

describe('imageMediaTypeOf', () => {
  it('maps every served type to its exact media type', () => {
    expect(imageMediaTypeOf('png')).toBe('image/png');
    expect(imageMediaTypeOf('jpeg')).toBe('image/jpeg');
    expect(imageMediaTypeOf('webp')).toBe('image/webp');
    expect(imageMediaTypeOf('gif')).toBe('image/gif');
  });
});
