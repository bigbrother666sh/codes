> This file extends [common/security.md](../common/security.md) with web-specific security content.

# Web Security Rules

## Content Security Policy

Always configure a production CSP. Use per-request nonce for scripts instead of `'unsafe-inline'`.

```text
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'nonce-{RANDOM}';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https:;
  frame-src 'none';
  object-src 'none';
  base-uri 'self';
```

## XSS Prevention

- Never inject unsanitized HTML
- Avoid `innerHTML` / `dangerouslySetInnerHTML` unless sanitized first
- Sanitize user HTML with a vetted local sanitizer when absolutely necessary

## HTTPS and Headers

```text
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
```

## Forms

- CSRF protection on state-changing forms
- Rate limiting on submission endpoints
- Validate client and server side
