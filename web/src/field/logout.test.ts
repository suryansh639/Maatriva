import { describe, expect, it, vi } from 'vitest';

import { translate } from '../shared/i18n';
import { confirmLogout } from './logout';

const tEn = (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) => translate('en', key, vars);
const tHi = (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) => translate('hi', key, vars);

describe('confirmLogout (Req 37.7)', () => {
  it('proceeds without asking when the outbox is empty', () => {
    const confirmFn = vi.fn(() => false);
    expect(confirmLogout(0, tEn, confirmFn)).toBe(true);
    expect(confirmFn).not.toHaveBeenCalled();
  });

  it('treats negative or non-finite counts as empty', () => {
    const confirmFn = vi.fn(() => false);
    expect(confirmLogout(-3, tEn, confirmFn)).toBe(true);
    expect(confirmLogout(Number.NaN, tEn, confirmFn)).toBe(true);
    expect(confirmFn).not.toHaveBeenCalled();
  });

  it('asks with the pending count and follows the answer', () => {
    const yes = vi.fn(() => true);
    expect(confirmLogout(2, tEn, yes)).toBe(true);
    expect(yes).toHaveBeenCalledWith(
      '2 changes are not synced yet. They stay saved on this phone. Log out anyway?',
    );

    const no = vi.fn(() => false);
    expect(confirmLogout(1, tEn, no)).toBe(false);
    expect(no).toHaveBeenCalledTimes(1);
  });

  it('uses the current language for the warning', () => {
    let message = '';
    confirmLogout(3, tHi, (m) => {
      message = m;
      return true;
    });
    expect(message.startsWith('3 ')).toBe(true);
    expect(message).toContain('लॉग आउट');
  });
});
