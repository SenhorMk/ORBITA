---
name: orbita-security
description: Apply ORBITA's OWASP ASVS Level 2 security baseline to authentication, authorization, tenant isolation, cookies, webhooks, secrets, Supabase access, validation, logging, and external APIs. Use for security reviews and any change affecting auth, permissions, data access, webhooks, cookies, integrations, or sensitive configuration.
---

# ORBITA Security

Read `references/security-baseline.md` and inspect the affected trust boundaries.

1. Authenticate at the server boundary and authorize the action and tenant separately.
2. Derive actor and organization identifiers from verified server-side identity, never request payloads alone.
3. Parse input and external data; reject invalid privilege-bearing values.
4. Keep service-role keys, OAuth secrets, encryption keys, and webhook secrets server-only.
5. Verify webhooks before side effects and make handling replay-safe.
6. Fail closed; never use silent catches or permissive fallbacks in security paths.
7. Log security events without secrets or sensitive payloads.
8. Use Database Sentinel for database/RLS work and Strix for authorized release or high-risk gates.
