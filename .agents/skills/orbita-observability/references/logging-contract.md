# Logging contract

Recommended fields: `timestamp`, `level`, `event`, `requestId`, `userId`, `organizationId`, `module`, `action`, `outcome`, `durationMs`, `statusCode`, `provider`, and a safe error code.

Forbidden: passwords, cookies, authorization headers, API keys, client secrets, service-role keys, access/refresh tokens, encryption keys, webhook secrets, raw bodies, and unnecessary personal data.

Generate request IDs with a strong UUID. Accept incoming IDs only after validating length and characters. Return the ID in a response header and pass it to providers where supported.

Audit events describe who did what to which tenant-scoped resource and whether it succeeded. Operational logs are not an audit trail.
