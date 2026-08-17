# Security baseline

Target OWASP ASVS 5.0 Level 2 controls relevant to architecture, authentication, sessions, access control, validation, cryptography, logging, data protection, API security, configuration, and business logic.

## Cookies and consent

- Essential cookies: authentication, session, security, and CSRF. Use `Secure` in production, `HttpOnly` when JavaScript access is unnecessary, and narrow `SameSite`, domain, path, and lifetime.
- Optional analytics, marketing, or tracking must not load before consent. Persist and honor the choice and support withdrawal.

## Trust rules

- Browser Supabase code uses only publishable/anon credentials and remains constrained by RLS.
- Service-role access is server-only and still enforces authorization and tenant scope in application code.
- Secrets never enter `NEXT_PUBLIC_*`, logs, client bundles, errors, screenshots, fixtures, or commits.
- Mutating routes require authenticated identity or verified provider webhook authenticity.
- OAuth state/callback handling resists CSRF and token replay.
