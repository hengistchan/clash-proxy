import { HttpError } from './http';
const MAX_URL_LENGTH = 16384;
export function validateSubscriptionUrl(raw: string): string {
  const value = raw.trim();
  if (!value || value.length > MAX_URL_LENGTH) {
    throw new HttpError(400, 'The subscription URL is missing or too long');
  }
  if (/[\s\r\n\t]/.test(value)) {
    throw new HttpError(
      400,
      'Whitespace is not allowed in the subscription URL'
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(400, 'The subscription URL is invalid');
  }
  if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new HttpError(400, 'The subscription URL must use HTTP or HTTPS');
  }
  if (parsed.hash)
    throw new HttpError(
      400,
      'Fragments are not allowed in the subscription URL'
    );
  if (parsed.hostname.endsWith('example.invalid')) {
    throw new HttpError(
      400,
      'Replace the template placeholder with a real subscription URL'
    );
  }
  return value;
}
