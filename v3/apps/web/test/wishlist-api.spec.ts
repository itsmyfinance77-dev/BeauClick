import { ApiRequestError } from '@/lib/api-client';
import { classifySaveFailure, saveFailureMessage } from '@/lib/wishlist-api';

/**
 * A refused save is one of three things to the customer. The cap is the only
 * refusal about their own list; every other reason a target cannot be saved is
 * ONE answer on the server, and the page must not split it.
 */
describe('classifySaveFailure', () => {
  it('reads the cap by its own code on a 409', () => {
    expect(classifySaveFailure(new ApiRequestError('WISHLIST_LIMIT_REACHED', 'x', 409))).toBe('limit_reached');
  });

  it('does not read a 409 with another code as the cap', () => {
    expect(classifySaveFailure(new ApiRequestError('SOMETHING_ELSE', 'x', 409))).toBe('failed');
  });

  it('reads a 404 as the one collapsed “unavailable”, whatever the reason behind it', () => {
    expect(classifySaveFailure(new ApiRequestError('NOT_FOUND_OR_NOT_YOURS', 'x', 404))).toBe('target_unavailable');
  });

  it('reads everything else as a plain failure', () => {
    expect(classifySaveFailure(new ApiRequestError('INTERNAL', 'x', 500))).toBe('failed');
    expect(classifySaveFailure(new TypeError('Failed to fetch'))).toBe('failed');
  });
});

describe('saveFailureMessage', () => {
  it('uses the server’s own sentence for a full list', () => {
    const message = 'فهرست علاقه‌مندی‌های شما پر است.';
    expect(saveFailureMessage(new ApiRequestError('WISHLIST_LIMIT_REACHED', message, 409))).toBe(message);
  });

  it('says one thing for an unavailable target and never a cause', () => {
    expect(saveFailureMessage(new ApiRequestError('NOT_FOUND_OR_NOT_YOURS', 'این مورد یافت نشد.', 404))).toBe('این مورد دیگر در دسترس نیست.');
  });

  it('says a plain failure plainly', () => {
    expect(saveFailureMessage(new TypeError('Failed to fetch'))).toBe('ذخیره انجام نشد. دوباره تلاش کنید.');
  });
});
