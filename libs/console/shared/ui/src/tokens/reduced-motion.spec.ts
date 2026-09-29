import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function tokensCss(): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tokens.css'), 'utf8');
}

// The reduced-motion blocks collapse every duration to a frame *except* --dur-fade: the approved
// design (docs/design/directions/01-paper-desk.html, "Signature moment") keeps a 120ms fade for
// the stamp even with reduced motion. Regression for #79, where both blocks set it to 1ms.
function reducedMotionBlocks(css: string): string[] {
  const blocks: string[] = [];
  const mediaMatch = /@media \(prefers-reduced-motion: reduce\) \{\s*:root:not\(\[data-motion='full'\]\) \{([^}]*)\}/.exec(
    css,
  );
  if (mediaMatch?.[1]) {
    blocks.push(mediaMatch[1]);
  }
  const attrMatch = /:root\[data-motion='reduce'\] \{([^}]*)\}/.exec(css);
  if (attrMatch?.[1]) {
    blocks.push(attrMatch[1]);
  }
  return blocks;
}

describe('reduced-motion tokens', () => {
  const blocks = reducedMotionBlocks(tokensCss());

  it('finds both reduced-motion blocks', () => {
    expect(blocks).toHaveLength(2);
  });

  it('does not override --dur-fade (stamp keeps its 120ms fade)', () => {
    for (const block of blocks) {
      expect(block).not.toMatch(/--dur-fade:/);
    }
  });

  it('still collapses the other durations to 1ms', () => {
    for (const block of blocks) {
      expect(block).toMatch(/--dur-fast:\s*1ms;/);
      expect(block).toMatch(/--dur-base:\s*1ms;/);
      expect(block).toMatch(/--dur-slow:\s*1ms;/);
      expect(block).toMatch(/--dur-sig:\s*1ms;/);
    }
  });

  it('keeps --dur-fade at 120ms in the base token block', () => {
    expect(tokensCss()).toMatch(/--dur-fade:\s*120ms;/);
  });
});
