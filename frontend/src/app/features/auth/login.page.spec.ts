import { safeReturnUrl } from './login.page';

describe('safeReturnUrl', () => {
  it('accepts in-app paths', () =>
    expect(safeReturnUrl('/fleet?sort=p95')).toBe('/fleet?sort=p95'));
  it.each([null, '', 'https://evil.example', '//evil.example', 'fleet'])(
    'falls back to /fleet for %s',
    (value) => expect(safeReturnUrl(value)).toBe('/fleet'),
  );
});
