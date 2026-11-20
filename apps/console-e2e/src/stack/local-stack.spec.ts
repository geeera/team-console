import { afterEach, describe, expect, it, vi } from 'vitest';
import { signal } from './local-stack';

/**
 * #846: local e2e teardown hit `kill EPERM` on macOS at `signal(-pid, 'SIGKILL')` when the child had already
 * exited. `signal` must treat that EPERM the same as ESRCH — but only once a probe confirms the pid is actually
 * gone; an EPERM for a pid that is still alive is a real permission problem and must still throw.
 */

function codedError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe('signal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the signal and returns when the kill succeeds', () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);

    expect(() => signal(123, 'SIGTERM', 123)).not.toThrow();
    expect(kill).toHaveBeenCalledExactlyOnceWith(123, 'SIGTERM');
  });

  it('treats ESRCH (already gone) as the stop it wants, without probing', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw codedError('ESRCH');
    });

    expect(() => signal(-123, 'SIGKILL', 123)).not.toThrow();
    expect(kill).toHaveBeenCalledExactlyOnceWith(-123, 'SIGKILL');
  });

  it('treats EPERM as already gone once the probe answers ESRCH for the pid (#846)', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementationOnce(() => {
      throw codedError('EPERM');
    });
    kill.mockImplementationOnce(() => {
      throw codedError('ESRCH');
    });

    expect(() => signal(-123, 'SIGKILL', 123)).not.toThrow();
    expect(kill).toHaveBeenNthCalledWith(1, -123, 'SIGKILL');
    expect(kill).toHaveBeenNthCalledWith(2, 123, 0);
  });

  it('still throws EPERM when the probe finds the pid alive', () => {
    const kill = vi.spyOn(process, 'kill');
    kill.mockImplementationOnce(() => {
      throw codedError('EPERM');
    });
    kill.mockImplementationOnce(() => true);

    expect(() => signal(-123, 'SIGKILL', 123)).toThrow(expect.objectContaining({ code: 'EPERM' }));
  });

  it('still throws EPERM when the probe itself answers EPERM (the pid exists, just not ours)', () => {
    const kill = vi.spyOn(process, 'kill');
    kill.mockImplementationOnce(() => {
      throw codedError('EPERM');
    });
    kill.mockImplementationOnce(() => {
      throw codedError('EPERM');
    });

    expect(() => signal(-123, 'SIGKILL', 123)).toThrow(expect.objectContaining({ code: 'EPERM' }));
  });

  it('never swallows an error that is neither ESRCH nor EPERM', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw codedError('EINVAL');
    });

    expect(() => signal(-123, 'SIGKILL', 123)).toThrow(expect.objectContaining({ code: 'EINVAL' }));
  });
});
