import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';
import { BOOTSTRAP_ADMIN_EMAIL, OperationType, db, handleFirestoreError } from '../firebase';
import type {
  AuditAction,
  AuditLogEntry,
  DocumentChunk,
  DocumentClassification,
  DocumentFileType,
  DocumentSourceType,
  DocumentVisibility,
  EnterpriseConnector,
  KnowledgeDocument,
  RoleGrant,
  SearchAnalyticEvent,
  UserProfile,
  UserRole,
} from '../types';

export function makeSafeId(prefix: string): string {
  const raw = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  return raw.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 120);
}

function clampStr(val: string, maxLen: number, fallback = ''): string {
  const cleaned = (val || fallback).trim();
  return cleaned.length > 0 ? cleaned.slice(0, maxLen) : fallback.slice(0, maxLen);
}

export async function ensureUserProfile(user: User): Promise<UserProfile> {
  const path = `userProfiles/${user.uid}`;
  const ref = doc(db, 'userProfiles', user.uid);
  try {
    const snap = await getDoc(ref);
    if (snap.exists()) {
      return snap.data() as UserProfile;
    }

    const isBootstrapAdmin = user.email === BOOTSTRAP_ADMIN_EMAIL && user.emailVerified;
    const profilePayload = {
      uid: user.uid,
      email: clampStr(user.email || 'user@enterprise.local', 254),
      displayName: clampStr(user.displayName || user.email?.split('@')[0] || 'Enterprise User', 120),
      role: (isBootstrapAdmin ? 'admin' : 'viewer') as UserRole,
      department: isBootstrapAdmin ? 'Security & Administration' : 'General',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    await setDoc(ref, profilePayload);
    const created = await getDoc(ref);
    return created.data() as UserProfile;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export function subscribeUserProfiles(
  isAdminUser: boolean,
  currentUid: string,
  onData: (profiles: UserProfile[]) => void
): Unsubscribe {
  if (isAdminUser) {
    const q = query(collection(db, 'userProfiles'), orderBy('createdAt', 'desc'));
    return onSnapshot(
      q,
      (snap) => {
        onData(snap.docs.map((d) => d.data() as UserProfile));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'userProfiles')
    );
  }

  return onSnapshot(
    doc(db, 'userProfiles', currentUid),
    (snap) => {
      onData(snap.exists() ? [snap.data() as UserProfile] : []);
    },
    (err) => handleFirestoreError(err, OperationType.GET, `userProfiles/${currentUid}`)
  );
}

export function subscribeRoleGrants(
  isAdminUser: boolean,
  userEmail: string,
  onData: (grants: RoleGrant[]) => void
): Unsubscribe {
  const colRef = collection(db, 'roleGrants');
  const q = isAdminUser
    ? query(colRef, orderBy('createdAt', 'desc'))
    : query(colRef, where('email', '==', userEmail));

  return onSnapshot(
    q,
    (snap) => {
      onData(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<RoleGrant, 'id'>) })));
    },
    (err) => handleFirestoreError(err, OperationType.LIST, 'roleGrants')
  );
}

export function subscribeAuthorizedDocuments(
  isAdminUser: boolean,
  userUid: string,
  userEmail: string,
  onData: (docs: KnowledgeDocument[]) => void
): Unsubscribe {
  const colRef = collection(db, 'documents');

  if (isAdminUser) {
    const q = query(colRef, orderBy('createdAt', 'desc'));
    return onSnapshot(
      q,
      (snap) => {
        onData(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<KnowledgeDocument, 'id'>) })));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'documents')
    );
  }

  // Scoped queries matching Firestore security rules without blanket reads
  const buckets = new Map<string, Map<string, KnowledgeDocument>>();
  const emitMerged = () => {
    const merged = new Map<string, KnowledgeDocument>();
    for (const bucket of buckets.values()) {
      for (const [id, item] of bucket.entries()) {
        merged.set(id, item);
      }
    }
    const sorted = Array.from(merged.values()).sort((a, b) => {
      const ta = a.createdAt?.toMillis?.() || 0;
      const tb = b.createdAt?.toMillis?.() || 0;
      return tb - ta;
    });
    onData(sorted);
  };

  const listenBucket = (key: string, q: ReturnType<typeof query>) =>
    onSnapshot(
      q,
      (snap) => {
        const map = new Map<string, KnowledgeDocument>();
        for (const d of snap.docs) {
          map.set(d.id, { id: d.id, ...(d.data() as Omit<KnowledgeDocument, 'id'>) });
        }
        buckets.set(key, map);
        emitMerged();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, `documents[${key}]`)
    );

  const unsubOwned = listenBucket('owned', query(colRef, where('ownerId', '==', userUid)));
  const unsubOrg = listenBucket('org', query(colRef, where('visibility', '==', 'organization')));
  const unsubShared = listenBucket('shared', query(colRef, where('allowedEmails', 'array-contains', userEmail)));

  return () => {
    unsubOwned();
    unsubOrg();
    unsubShared();
  };
}

export function subscribeConnectors(
  isAdminUser: boolean,
  userUid: string,
  onData: (connectors: EnterpriseConnector[]) => void
): Unsubscribe {
  const colRef = collection(db, 'connectors');
  const q = isAdminUser
    ? query(colRef, orderBy('createdAt', 'desc'))
    : query(colRef, where('ownerId', '==', userUid));

  return onSnapshot(
    q,
    (snap) => {
      onData(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<EnterpriseConnector, 'id'>) })));
    },
    (err) => handleFirestoreError(err, OperationType.LIST, 'connectors')
  );
}

export function subscribeAuditLogs(
  isAdminUser: boolean,
  userUid: string,
  onData: (logs: AuditLogEntry[]) => void
): Unsubscribe {
  const colRef = collection(db, 'auditLogs');
  const q = isAdminUser
    ? query(colRef, orderBy('createdAt', 'desc'))
    : query(colRef, where('actorUid', '==', userUid));

  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<AuditLogEntry, 'id'>) }));
      rows.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
      onData(rows.slice(0, 100));
    },
    (err) => handleFirestoreError(err, OperationType.LIST, 'auditLogs')
  );
}

export function subscribeSearchAnalytics(
  onData: (events: SearchAnalyticEvent[]) => void
): Unsubscribe {
  const q = query(collection(db, 'searchAnalytics'), where('orgScope', '==', 'enterprise'));
  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<SearchAnalyticEvent, 'id'>),
      }));
      rows.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
      onData(rows.slice(0, 500));
    },
    (err) => handleFirestoreError(err, OperationType.LIST, 'searchAnalytics')
  );
}

export async function recordSearchAnalytic(params: {
  rawQuery: string;
  department: string;
  outcome: 'answered' | 'knowledge_gap';
  citationCount: number;
}): Promise<void> {
  const eventId = makeSafeId('sq');
  const normalized = params.rawQuery
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

  try {
    await setDoc(doc(db, 'searchAnalytics', eventId), {
      orgScope: 'enterprise',
      normalizedQuery: clampStr(normalized || params.rawQuery, 200, 'query'),
      rawQuery: clampStr(params.rawQuery, 240, 'query'),
      department: clampStr(params.department, 80, 'General'),
      outcome: params.outcome,
      citationCount: Math.max(0, Math.min(500, Math.floor(params.citationCount))),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `searchAnalytics/${eventId}`);
  }
}

export async function logAuditEvent(params: {
  actorUid: string;
  actorEmail: string;
  actorRole: string;
  action: AuditAction;
  targetId: string;
  targetTitle: string;
  details: string;
  piiRedacted: boolean;
}): Promise<void> {
  const logId = makeSafeId('log');
  const path = `auditLogs/${logId}`;
  try {
    await setDoc(doc(db, 'auditLogs', logId), {
      actorUid: clampStr(params.actorUid, 128),
      actorEmail: clampStr(params.actorEmail, 254),
      actorRole: clampStr(params.actorRole, 40),
      action: params.action,
      targetId: clampStr(params.targetId, 128),
      targetTitle: clampStr(params.targetTitle, 200),
      details: clampStr(params.details, 600),
      piiRedacted: Boolean(params.piiRedacted),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export function resolveEmailsForRoles(
  allowedRoles: UserRole[],
  explicitEmails: string[],
  roleGrants: RoleGrant[],
  userProfiles: UserProfile[]
): string[] {
  const emailSet = new Set<string>();
  for (const e of explicitEmails) {
    const clean = e.trim().toLowerCase();
    if (clean && clean.includes('@')) {
      emailSet.add(clean);
    }
  }
  for (const grant of roleGrants) {
    if (allowedRoles.includes(grant.role)) {
      emailSet.add(grant.email.trim().toLowerCase());
    }
  }
  for (const profile of userProfiles) {
    if (allowedRoles.includes(profile.role)) {
      emailSet.add(profile.email.trim().toLowerCase());
    }
  }
  return Array.from(emailSet).slice(0, 25);
}

export async function saveDocumentWithChunks(params: {
  title: string;
  fileName: string;
  fileType: DocumentFileType;
  fileSize: number;
  pageCount: number;
  department: string;
  classification: DocumentClassification;
  visibility: DocumentVisibility;
  allowedRoles: UserRole[];
  allowedEmails: string[];
  allowAiQuery: boolean;
  allowDownload: boolean;
  redactPiiOnTransmit: boolean;
  allowExternalShare: boolean;
  sourceType: DocumentSourceType;
  sourceConnectorId: string;
  ownerId: string;
  ownerEmail: string;
  chunks: Array<{
    chunkIndex: number;
    pageNumber: number;
    sectionTitle: string;
    text: string;
    charCount: number;
  }>;
}): Promise<string> {
  const docId = makeSafeId('doc');
  const docRef = doc(db, 'documents', docId);
  const safeRoles = params.allowedRoles.slice(0, 10);
  const safeEmails = params.allowedEmails.slice(0, 25);

  try {
    await setDoc(docRef, {
      title: clampStr(params.title, 200, 'Untitled Document'),
      fileName: clampStr(params.fileName, 240, 'document.pdf'),
      fileType: params.fileType,
      fileSize: Math.max(0, Math.min(52428800, Math.floor(params.fileSize))),
      pageCount: Math.max(1, Math.min(5000, Math.floor(params.pageCount))),
      chunkCount: Math.max(1, Math.min(5000, params.chunks.length)),
      department: clampStr(params.department, 80, 'General'),
      classification: params.classification,
      visibility: params.visibility,
      allowedRoles: safeRoles,
      allowedEmails: safeEmails,
      allowAiQuery: Boolean(params.allowAiQuery),
      allowDownload: Boolean(params.allowDownload),
      redactPiiOnTransmit: Boolean(params.redactPiiOnTransmit),
      allowExternalShare: Boolean(params.allowExternalShare),
      sourceType: params.sourceType,
      sourceConnectorId: clampStr(params.sourceConnectorId, 128),
      ownerId: params.ownerId,
      ownerEmail: params.ownerEmail,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    // Write chunks in batches of 400 (Firestore batch limit is 500)
    const batchSize = 400;
    for (let i = 0; i < params.chunks.length; i += batchSize) {
      const batch = writeBatch(db);
      const slice = params.chunks.slice(i, i + batchSize);
      for (const ch of slice) {
        const chunkId = `chunk_${String(ch.chunkIndex).padStart(4, '0')}`;
        const chunkRef = doc(db, 'documents', docId, 'chunks', chunkId);
        const safeText = ch.text.slice(0, 11800);
        batch.set(chunkRef, {
          docId,
          ownerId: params.ownerId,
          visibility: params.visibility,
          allowedEmails: safeEmails,
          chunkIndex: ch.chunkIndex,
          pageNumber: Math.max(1, ch.pageNumber),
          sectionTitle: clampStr(ch.sectionTitle, 200),
          text: safeText,
          charCount: safeText.length,
          createdAt: serverTimestamp(),
        });
      }
      await batch.commit();
    }

    return docId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `documents/${docId}`);
  }
}

export async function updateDocumentPolicies(
  docId: string,
  updates: {
    title: string;
    department: string;
    classification: DocumentClassification;
    visibility: DocumentVisibility;
    allowedRoles: UserRole[];
    allowedEmails: string[];
    allowAiQuery: boolean;
    allowDownload: boolean;
    redactPiiOnTransmit: boolean;
    allowExternalShare: boolean;
  }
): Promise<void> {
  const path = `documents/${docId}`;
  const safeEmails = updates.allowedEmails.slice(0, 25);
  try {
    await updateDoc(doc(db, 'documents', docId), {
      title: clampStr(updates.title, 200),
      department: clampStr(updates.department, 80),
      classification: updates.classification,
      visibility: updates.visibility,
      allowedRoles: updates.allowedRoles.slice(0, 10),
      allowedEmails: safeEmails,
      allowAiQuery: Boolean(updates.allowAiQuery),
      allowDownload: Boolean(updates.allowDownload),
      redactPiiOnTransmit: Boolean(updates.redactPiiOnTransmit),
      allowExternalShare: Boolean(updates.allowExternalShare),
      updatedAt: serverTimestamp(),
    });

    // Keep chunk visibility and allowedEmails synchronized
    const chunksSnap = await getDocs(collection(db, 'documents', docId, 'chunks'));
    if (!chunksSnap.empty) {
      const batch = writeBatch(db);
      for (const chDoc of chunksSnap.docs) {
        batch.update(chDoc.ref, {
          visibility: updates.visibility,
          allowedEmails: safeEmails,
        });
      }
      await batch.commit();
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteDocumentAndChunks(docId: string): Promise<void> {
  const path = `documents/${docId}`;
  try {
    const chunksSnap = await getDocs(collection(db, 'documents', docId, 'chunks'));
    if (!chunksSnap.empty) {
      const batch = writeBatch(db);
      for (const chDoc of chunksSnap.docs) {
        batch.delete(chDoc.ref);
      }
      await batch.commit();
    }
    await deleteDoc(doc(db, 'documents', docId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function fetchDocumentChunks(docId: string): Promise<DocumentChunk[]> {
  const path = `documents/${docId}/chunks`;
  try {
    const q = query(collection(db, 'documents', docId, 'chunks'), orderBy('chunkIndex', 'asc'));
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<DocumentChunk, 'id'>) }));
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function upsertRoleGrant(params: {
  grantId?: string;
  email: string;
  displayName: string;
  role: UserRole;
  department: string;
  canUpload: boolean;
  canManageConnectors: boolean;
  canExport: boolean;
  grantedBy: string;
}): Promise<string> {
  const cleanEmail = params.email.trim().toLowerCase().slice(0, 254);
  const id = params.grantId || makeSafeId('grant');
  const ref = doc(db, 'roleGrants', id);
  try {
    const existing = await getDoc(ref);
    if (existing.exists()) {
      await updateDoc(ref, {
        displayName: clampStr(params.displayName, 120, cleanEmail),
        role: params.role,
        department: clampStr(params.department, 80, 'General'),
        canUpload: Boolean(params.canUpload),
        canManageConnectors: Boolean(params.canManageConnectors),
        canExport: Boolean(params.canExport),
        grantedBy: params.grantedBy,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(ref, {
        email: cleanEmail,
        displayName: clampStr(params.displayName, 120, cleanEmail),
        role: params.role,
        department: clampStr(params.department, 80, 'General'),
        canUpload: Boolean(params.canUpload),
        canManageConnectors: Boolean(params.canManageConnectors),
        canExport: Boolean(params.canExport),
        grantedBy: params.grantedBy,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    return id;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `roleGrants/${id}`);
  }
}

export async function removeRoleGrant(grantId: string): Promise<void> {
  try {
    await deleteDoc(doc(db, 'roleGrants', grantId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `roleGrants/${grantId}`);
  }
}

export async function updateUserProfileRole(uid: string, role: UserRole, department: string): Promise<void> {
  try {
    await updateDoc(doc(db, 'userProfiles', uid), {
      role,
      department: clampStr(department, 80, 'General'),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `userProfiles/${uid}`);
  }
}

export async function createConnectorRecord(params: {
  name: string;
  provider: 'confluence' | 'notion' | 'slack' | 'webhook';
  endpointUrl: string;
  defaultVisibility: DocumentVisibility;
  defaultAllowedRoles: UserRole[];
  allowAiQuery: boolean;
  redactPiiOnTransmit: boolean;
  ownerId: string;
}): Promise<string> {
  const id = makeSafeId('conn');
  try {
    await setDoc(doc(db, 'connectors', id), {
      name: clampStr(params.name, 120, 'Enterprise Connector'),
      provider: params.provider,
      endpointUrl: clampStr(params.endpointUrl, 500),
      status: 'active',
      defaultVisibility: params.defaultVisibility,
      defaultAllowedRoles: params.defaultAllowedRoles.slice(0, 10),
      allowAiQuery: Boolean(params.allowAiQuery),
      redactPiiOnTransmit: Boolean(params.redactPiiOnTransmit),
      lastSyncedAt: 'Never',
      syncedDocCount: 0,
      ownerId: params.ownerId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return id;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `connectors/${id}`);
  }
}

export async function markConnectorSynced(connectorId: string, nextDocCount: number): Promise<void> {
  try {
    await updateDoc(doc(db, 'connectors', connectorId), {
      lastSyncedAt: new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC',
      syncedDocCount: Math.max(0, nextDocCount),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `connectors/${connectorId}`);
  }
}

export async function toggleConnectorStatus(connectorId: string, status: 'active' | 'paused'): Promise<void> {
  try {
    await updateDoc(doc(db, 'connectors', connectorId), {
      status,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `connectors/${connectorId}`);
  }
}

export async function deleteConnectorRecord(connectorId: string): Promise<void> {
  try {
    await deleteDoc(doc(db, 'connectors', connectorId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `connectors/${connectorId}`);
  }
}

export function canEffectiveRoleAccessDoc(
  docItem: KnowledgeDocument,
  effectiveRole: UserRole,
  userUid: string,
  userEmail: string
): boolean {
  if (effectiveRole === 'admin') return true;
  if (docItem.ownerId === userUid) return true;
  if (docItem.visibility === 'organization') return true;
  if (docItem.allowedEmails.includes(userEmail.toLowerCase())) return true;
  if (docItem.visibility === 'role_restricted' && docItem.allowedRoles.includes(effectiveRole)) return true;
  return false;
}
