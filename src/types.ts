import type { Timestamp } from 'firebase/firestore';

export type UserRole = 'admin' | 'manager' | 'engineering' | 'legal' | 'finance' | 'viewer';

export type DocumentClassification = 'public_internal' | 'confidential' | 'restricted';
export type DocumentVisibility = 'private' | 'role_restricted' | 'organization';
export type DocumentSourceType = 'manual_upload' | 'confluence' | 'notion' | 'slack' | 'webhook';
export type DocumentFileType = 'pdf' | 'txt' | 'md' | 'csv' | 'json' | 'connector';

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  role: UserRole;
  department: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface RoleGrant {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  department: string;
  canUpload: boolean;
  canManageConnectors: boolean;
  canExport: boolean;
  grantedBy: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  fileName: string;
  fileType: DocumentFileType;
  fileSize: number;
  pageCount: number;
  chunkCount: number;
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
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface DocumentChunk {
  id: string;
  docId: string;
  ownerId: string;
  visibility: DocumentVisibility;
  allowedEmails: string[];
  chunkIndex: number;
  pageNumber: number;
  sectionTitle: string;
  text: string;
  charCount: number;
  createdAt?: Timestamp;
}

export interface EnterpriseConnector {
  id: string;
  name: string;
  provider: 'confluence' | 'notion' | 'slack' | 'webhook';
  endpointUrl: string;
  status: 'active' | 'paused';
  defaultVisibility: DocumentVisibility;
  defaultAllowedRoles: UserRole[];
  allowAiQuery: boolean;
  redactPiiOnTransmit: boolean;
  lastSyncedAt: string;
  syncedDocCount: number;
  ownerId: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export type AuditAction =
  | 'document_upload'
  | 'ai_query'
  | 'ai_abstain'
  | 'policy_update'
  | 'connector_sync'
  | 'role_grant'
  | 'access_denied'
  | 'document_delete';

export interface AuditLogEntry {
  id: string;
  actorUid: string;
  actorEmail: string;
  actorRole: string;
  action: AuditAction;
  targetId: string;
  targetTitle: string;
  details: string;
  piiRedacted: boolean;
  createdAt?: Timestamp;
}

export interface Citation {
  docId: string;
  documentTitle: string;
  pageNumber: number;
  exactQuote: string;
}

export interface StructuredSection {
  heading: string;
  points: string[];
}

export interface QaMessage {
  id: string;
  question: string;
  answeredFromDocuments: boolean;
  summary?: string;
  sections?: StructuredSection[];
  answer: string;
  abstentionReason?: string;
  citations: Citation[];
  piiRedactedCount: number;
  chunksScanned: number;
  latencyMs?: number;
  scopeLabel: string;
  excludedCount: number;
  timestamp: string;
}

export interface EvaluationCaseInput {
  id: string;
  question: string;
  expectedBehavior: 'must_answer' | 'must_abstain';
  expectedKeywords?: string[];
}

export interface EvaluationCaseResult {
  id: string;
  question: string;
  expectedBehavior: 'must_answer' | 'must_abstain';
  passed: boolean;
  answeredFromDocuments: boolean;
  summary: string;
  answer: string;
  citationCount: number;
  verifiedCitationCount: number;
  latencyMs: number;
  diagnostic: string;
}

export interface EvaluationReport {
  overallScore: number;
  groundingFaithfulnessScore: number;
  hallucinationRejectionScore: number;
  citationPrecisionScore: number;
  avgLatencyMs: number;
  totalCases: number;
  passedCases: number;
  totalRedactedPii: number;
  evaluatedAt: string;
  results: EvaluationCaseResult[];
}

export interface SearchAnalyticEvent {
  id: string;
  orgScope: 'enterprise';
  normalizedQuery: string;
  rawQuery: string;
  department: string;
  outcome: 'answered' | 'knowledge_gap';
  citationCount: number;
  createdAt?: Timestamp;
}


