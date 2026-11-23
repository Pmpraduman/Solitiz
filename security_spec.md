# Security Specification & Invariants

## 1. Data Invariants
1. **Strict Ownership & Identity Binding**: Every `userProfiles/{userId}` document must have `uid == userId == request.auth.uid`, and non-admin users cannot self-assign privileged roles (`admin`, `manager`, `engineering`, `legal`, `finance`) on creation or update.
2. **Verified Email Gate**: All standard reads and writes require `request.auth != null && request.auth.token.email_verified == true`. Admin bootstrap applies exclusively to verified `pk9114712@gmail.com`.
3. **Document & Chunk Master Gate**: Every `documents/{docId}/chunks/{chunkId}` write must reference an existing parent `documents/{docId}` owned by `request.auth.uid` (or Admin) with matching `docId` and `ownerId`.
4. **Immutable Audit Trail**: `auditLogs/{logId}` entries are strictly append-only (`update` and `delete` always denied) and require `actorUid == request.auth.uid` and server timestamp `request.time`.
5. **No Blanket List Reads**: Every `allow list` rule evaluates `resource.data` directly (owner, visibility, allowedEmails, or verified admin token) without `get()` or `exists()` lookups.
6. **Temporal Integrity**: All `createdAt` and `updatedAt` fields must equal `request.time`, and `createdAt`/`ownerId`/`ownerEmail` are immutable on update.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Self-Assigned Admin Role**: Creating `/userProfiles/attacker1` with `{ role: 'admin', uid: 'attacker1', ... }` as non-admin -> `PERMISSION_DENIED`.
2. **Unverified Email Spoof**: Writing any document when `request.auth.token.email_verified == false` -> `PERMISSION_DENIED`.
3. **Shadow Ghost Field Injection**: Creating `/documents/doc1` with extra unexpected key `{ isApproved: true }` -> `PERMISSION_DENIED`.
4. **Owner Spoofing**: Creating `/documents/doc2` with `ownerId: 'victimUid'` -> `PERMISSION_DENIED`.
5. **Orphaned Chunk Write**: Creating `/documents/nonexistent/chunks/c1` -> `PERMISSION_DENIED`.
6. **Non-Owner Policy Escalation**: Non-owner updating `allowAiQuery` or `allowedRoles` on a private document -> `PERMISSION_DENIED`.
7. **Immutable Field Tampering**: Updating `createdAt` or `ownerId` on an existing `/documents/doc1` -> `PERMISSION_DENIED`.
8. **Backdated Timestamp Injection**: Creating `/auditLogs/log1` with client timestamp instead of `request.time` -> `PERMISSION_DENIED`.
9. **Audit Log Deletion / Mutation**: Updating or deleting `/auditLogs/log1` -> `PERMISSION_DENIED`.
10. **ID Poisoning**: Creating `/documents/invalid$id*with!badchars` or >128 char ID -> `PERMISSION_DENIED`.
11. **Oversized Array / String DoS**: Creating `/documents/doc3` with `allowedEmails` length 30 (>25) or `title` > 200 chars -> `PERMISSION_DENIED`.
12. **Cross-Tenant PII Read**: Reading another user's `/userProfiles/otherUid` as a non-admin -> `PERMISSION_DENIED`.
