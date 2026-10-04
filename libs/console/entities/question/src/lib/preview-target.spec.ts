import { previewTargetOf } from './preview-target';

const STORYBOOK = 'https://team-console-storybook.pages.dev';
const STAGE = 'https://team-console-stage.geeera.workers.dev';

describe('previewTargetOf', () => {
  it('picks the first link the project allows framing, wherever it is', () => {
    expect(
      previewTargetOf(
        [
          'https://github.com/geeera/team-console/pull/9',
          'https://evil.pages.dev/',
          `${STAGE}/p/storify`,
          `${STORYBOOK}/?path=/story/x`,
        ],
        [STORYBOOK, STAGE],
      ),
    ).toBe(`${STAGE}/p/storify`);
  });

  it('falls back to the first link off GitHub, which the card shows as not embeddable', () => {
    expect(
      previewTargetOf(
        ['https://github.com/geeera/team-console/pull/9', 'https://www.figma.com/file/x', 'https://evil.pages.dev/'],
        [STORYBOOK],
      ),
    ).toBe('https://www.figma.com/file/x');
  });

  it('previews nothing when every link points at GitHub', () => {
    expect(
      previewTargetOf(
        ['https://github.com/geeera/team-console/issues/3', 'https://raw.githubusercontent.com/x/y/z.png'],
        [STORYBOOK],
      ),
    ).toBeNull();
    expect(previewTargetOf([], [STORYBOOK])).toBeNull();
  });

  it('never treats a look-alike of GitHub as GitHub', () => {
    expect(previewTargetOf(['https://github.com.evil.example/x'], [])).toBe('https://github.com.evil.example/x');
  });
});
