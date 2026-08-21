import { MissingTemplateVariableError, TemplateRegistry, UnknownTemplateError } from './template.registry';

describe('TemplateRegistry', () => {
  const templates = new TemplateRegistry();

  it('renders numbers in Persian digits', () => {
    const rendered = templates.render('payment_succeeded', { amountToman: '۸۵۰٬۰۰۰' });
    expect(rendered.body).toContain('۸۵۰٬۰۰۰');
    // Every user-facing number on this platform is Persian; an ASCII digit in
    // a Persian sentence reads as broken.
    expect(rendered.body).not.toMatch(/[0-9]/);
  });

  it('converts ASCII digits supplied by a caller', () => {
    const rendered = templates.render('loyalty_tier_changed', { tierName: 'gold 2' });
    expect(rendered.body).toContain('۲');
    expect(rendered.body).not.toContain(' 2');
  });

  it('THROWS on a missing variable rather than leaving a placeholder', () => {
    // V2 substituted what it had and shipped the rest, so a customer could
    // receive a literal "{date}". Failing loudly at request time is strictly
    // better than delivering nonsense.
    expect(() => templates.render('booking_confirmed', { professionalName: 'X', date: '۱۴۰۵/۰۵/۳۰' })).toThrow(
      MissingTemplateVariableError,
    );
  });

  it('treats an empty string as missing', () => {
    expect(() =>
      templates.render('booking_confirmed', { professionalName: '', date: 'd', time: 't' }),
    ).toThrow(MissingTemplateVariableError);
  });

  it('rejects an unknown template key', () => {
    expect(() => templates.render('no_such_template', {})).toThrow(UnknownTemplateError);
  });

  it('leaves no unsubstituted placeholder in any rendered output', () => {
    const rendered = templates.render('booking_confirmed', {
      professionalName: 'سالن کیمیا',
      date: 'جمعه ۳۰ مرداد',
      time: '۱۴:۰۰',
    });
    for (const text of [rendered.subject, rendered.body, rendered.short]) {
      expect(text).not.toMatch(/\{[a-zA-Z]+\}/);
    }
  });

  it('maps every template to a real category', () => {
    expect(templates.categoryOf('booking_confirmed')).toBe('booking');
    expect(templates.categoryOf('payment_succeeded')).toBe('payment');
    expect(templates.categoryOf('loyalty_tier_changed')).toBe('loyalty');
  });

  it('produces a RELATIVE deep link, never an absolute URL', () => {
    // An absolute URL from a template would be an open-redirect surface the
    // moment any of these strings became configurable.
    const link = templates.deepLinkFor('booking_confirmed', {});
    expect(link).toBe('/bookings');
    expect(link?.startsWith('/')).toBe(true);
    expect(link).not.toMatch(/^https?:/);
  });

  it('does not Persian-digit a deep link', () => {
    // A path is machine-readable, not display text -- converting its digits
    // would produce a route that does not exist.
    const link = templates.deepLinkFor('loyalty_tier_changed', {});
    expect(link).toBe('/loyalty');
  });
});
