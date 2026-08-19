import { ArgumentsHost, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { BeauClickExceptionFilter } from './beauclick-exception.filter';
import { DomainException } from './domain.exception';

function fakeHost() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('BeauClickExceptionFilter', () => {
  it('passes through a DomainException\'s own code/message/details unchanged', () => {
    const filter = new BeauClickExceptionFilter();
    const { host, status, json } = fakeHost();

    filter.catch(new DomainException('CONFLICT', 'تکراری است.', 409, { field: 'phone' }), host);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({ data: null, meta: null, error: { code: 'CONFLICT', message: 'تکراری است.', details: { field: 'phone' } } });
  });

  it('maps a generic NestJS HttpException (no code field) to a generic Persian message by status', () => {
    const filter = new BeauClickExceptionFilter();
    const { host, status, json } = fakeHost();

    filter.catch(new NotFoundException(), host);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ data: null, meta: null, error: { code: 'NOT_FOUND_OR_NOT_YOURS', message: 'این مورد یافت نشد.' } });
  });

  it('never leaks a raw/unexpected error\'s message to the client -- always the generic Persian INTERNAL_ERROR shape', () => {
    const filter = new BeauClickExceptionFilter();
    const { host, status, json } = fakeHost();

    filter.catch(new Error('a raw driver error mentioning a real column name or secret'), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ data: null, meta: null, error: { code: 'INTERNAL_ERROR', message: 'خطایی در سرور رخ داد. لطفاً دوباره تلاش کنید.' } });
  });

  it('a real InternalServerErrorException still uses the generic mapped message, not its own default English text', () => {
    const filter = new BeauClickExceptionFilter();
    const { host, json } = fakeHost();

    filter.catch(new InternalServerErrorException(), host);

    const [[body]] = json.mock.calls;
    expect(body.error.message).not.toMatch(/[a-zA-Z]/); // Persian only, no leaked English text
  });
});
