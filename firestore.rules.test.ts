/**
 * Payload verification matrix corresponding to security_spec.md "Dirty Dozen" cases.
 * Used as reference test suite for Firestore Rules Simulator / Emulator verification.
 */
export interface SecurityTestCase {
  id: string;
  name: string;
  path: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  expected: 'PERMISSION_DENIED';
  payload?: Record<string, unknown>;
}

export const DIRTY_DOZEN_CASES: SecurityTestCase[] = [
  {
    id: 'DD-01',
    name: 'Self-Assigned Admin Role on UserProfile Create',
    path: 'userProfiles/user_bob',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    payload: { uid: 'user_bob', email: 'bob@example.com', displayName: 'Bob', role: 'admin', department: 'Ops' },
  },
  {
    id: 'DD-02',
    name: 'Unverified Email Spoof',
    path: 'documents/doc_1',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-03',
    name: 'Shadow Ghost Field Injection',
    path: 'documents/doc_1',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    payload: { title: 'Test', shadowAdminBypass: true },
  },
  {
    id: 'DD-04',
    name: 'Owner Spoofing on Document Create',
    path: 'documents/doc_2',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    payload: { ownerId: 'victim_uid' },
  },
  {
    id: 'DD-05',
    name: 'Orphaned Chunk Write Without Parent Document',
    path: 'documents/missing_doc/chunks/chunk_0',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-06',
    name: 'Non-Owner Policy Escalation Update',
    path: 'documents/doc_private',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
    payload: { visibility: 'organization', allowAiQuery: true },
  },
  {
    id: 'DD-07',
    name: 'Immutable OwnerId Tampering on Update',
    path: 'documents/doc_1',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
    payload: { ownerId: 'attacker_uid' },
  },
  {
    id: 'DD-08',
    name: 'Backdated Client Timestamp on AuditLog',
    path: 'auditLogs/log_1',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    payload: { createdAt: '2020-01-01T00:00:00Z' },
  },
  {
    id: 'DD-09',
    name: 'Audit Log Modification Attempt',
    path: 'auditLogs/log_1',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
    payload: { details: 'tampered' },
  },
  {
    id: 'DD-10',
    name: 'Invalid Document ID Character Poisoning',
    path: 'documents/bad$id!script',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-11',
    name: 'Oversized Title String DoS (>200 chars)',
    path: 'documents/doc_3',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    payload: { title: 'A'.repeat(250) },
  },
  {
    id: 'DD-12',
    name: 'Cross-Tenant UserProfile PII Read',
    path: 'userProfiles/other_uid',
    operation: 'get',
    expected: 'PERMISSION_DENIED',
  },
];
