import React, { useEffect, useState } from 'react';
import { Download, FileText, Lock, Shield, Trash2, X } from 'lucide-react';
import {
  deleteDocumentAndChunks,
  fetchDocumentChunks,
  logAuditEvent,
  resolveEmailsForRoles,
  updateDocumentPolicies,
} from '../services/knowledgeStore';
import type {
  DocumentChunk,
  DocumentClassification,
  DocumentVisibility,
  KnowledgeDocument,
  RoleGrant,
  UserProfile,
  UserRole,
} from '../types';

interface DocumentEvidenceDrawerProps {
  document: KnowledgeDocument | null;
  highlightPage?: number;
  highlightQuote?: string;
  onClose: () => void;
  userUid: string;
  userEmail: string;
  effectiveRole: UserRole;
  isTrueAdmin: boolean;
  roleGrants: RoleGrant[];
  userProfiles: UserProfile[];
  onDeleted: () => void;
}

const ALL_ROLES: UserRole[] = ['admin', 'manager', 'engineering', 'legal', 'finance', 'viewer'];

export function DocumentEvidenceDrawer({
  document,
  highlightPage,
  highlightQuote,
  onClose,
  userUid,
  userEmail,
  effectiveRole,
  isTrueAdmin,
  roleGrants,
  userProfiles,
  onDeleted,
}: DocumentEvidenceDrawerProps) {
  const [chunks, setChunks] = useState<DocumentChunk[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'evidence' | 'policies'>('evidence');
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [policyFeedback, setPolicyFeedback] = useState('');

  // Policy edit state
  const [title, setTitle] = useState('');
  const [department, setDepartment] = useState('');
  const [classification, setClassification] = useState<DocumentClassification>('confidential');
  const [visibility, setVisibility] = useState<DocumentVisibility>('private');
  const [allowedRoles, setAllowedRoles] = useState<UserRole[]>([]);
  const [emailsInput, setEmailsInput] = useState('');
  const [allowAiQuery, setAllowAiQuery] = useState(true);
  const [allowDownload, setAllowDownload] = useState(true);
  const [redactPiiOnTransmit, setRedactPiiOnTransmit] = useState(true);
  const [allowExternalShare, setAllowExternalShare] = useState(false);

  useEffect(() => {
    if (!document) return;
    setTab('evidence');
    setPolicyFeedback('');
    setTitle(document.title);
    setDepartment(document.department);
    setClassification(document.classification);
    setVisibility(document.visibility);
    setAllowedRoles(document.allowedRoles);
    setEmailsInput(document.allowedEmails.join(', '));
    setAllowAiQuery(document.allowAiQuery);
    setAllowDownload(document.allowDownload);
    setRedactPiiOnTransmit(document.redactPiiOnTransmit);
    setAllowExternalShare(document.allowExternalShare);

    setLoading(true);
    fetchDocumentChunks(document.id)
      .then((rows) => setChunks(rows))
      .finally(() => setLoading(false));
  }, [document]);

  if (!document) return null;

  const canManage = isTrueAdmin || document.ownerId === userUid;

  const handleExportText = () => {
    if (!document.allowDownload) return;
    const body = chunks
      .map((c) => `--- Page ${c.pageNumber} (Chunk ${c.chunkIndex + 1}) ---\n${c.text}`)
      .join('\n\n');
    const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = window.document.createElement('a');
    a.href = url;
    a.download = `${document.fileName.replace(/\.[^/.]+$/, '')}_extracted.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSavePolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManage) return;
    setSavingPolicy(true);
    setPolicyFeedback('');
    try {
      const explicitEmails = emailsInput
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.includes('@'));

      const effectiveRoles: UserRole[] =
        visibility === 'private'
          ? []
          : visibility === 'organization'
            ? ALL_ROLES
            : allowedRoles;

      const resolvedEmails =
        visibility === 'private'
          ? explicitEmails
          : resolveEmailsForRoles(effectiveRoles, explicitEmails, roleGrants, userProfiles);

      await updateDocumentPolicies(document.id, {
        title,
        department,
        classification,
        visibility,
        allowedRoles: effectiveRoles,
        allowedEmails: resolvedEmails,
        allowAiQuery,
        allowDownload,
        redactPiiOnTransmit,
        allowExternalShare,
      });

      await logAuditEvent({
        actorUid: userUid,
        actorEmail: userEmail,
        actorRole: effectiveRole,
        action: 'policy_update',
        targetId: document.id,
        targetTitle: title,
        details: `Updated access policy (${visibility}, roles: ${effectiveRoles.join('/') || 'none'}) & transmission controls (AI=${allowAiQuery}, RedactPII=${redactPiiOnTransmit}, Export=${allowDownload}).`,
        piiRedacted: redactPiiOnTransmit,
      });

      setPolicyFeedback('Access and transmission policies updated.');
    } finally {
      setSavingPolicy(false);
    }
  };

  const handleDelete = async () => {
    if (!canManage) return;
    await deleteDocumentAndChunks(document.id);
    await logAuditEvent({
      actorUid: userUid,
      actorEmail: userEmail,
      actorRole: effectiveRole,
      action: 'document_delete',
      targetId: document.id,
      targetTitle: document.title,
      details: `Deleted document ${document.fileName} and all ${document.chunkCount} indexed chunks.`,
      piiRedacted: false,
    });
    onDeleted();
    onClose();
  };

  const renderHighlightedText = (text: string, pageNumber: number) => {
    if (!highlightQuote || (highlightPage && pageNumber !== highlightPage)) {
      return <span>{text}</span>;
    }
    const cleanQuote = highlightQuote.trim();
    const idx = text.toLowerCase().indexOf(cleanQuote.toLowerCase());
    if (idx === -1) {
      return <span>{text}</span>;
    }
    return (
      <>
        <span>{text.slice(0, idx)}</span>
        <mark className="bg-emerald-100 text-emerald-950 px-0.5 rounded-xs font-medium">
          {text.slice(idx, idx + cleanQuote.length)}
        </mark>
        <span>{text.slice(idx + cleanQuote.length)}</span>
      </>
    );
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/40 flex justify-end">
      <div className="bg-white border-l border-slate-200 w-full max-w-2xl h-full flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <FileText className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{document.fileName}</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{document.pageCount} pages</span>
              <span aria-hidden="true">·</span>
              <span className="capitalize">{document.visibility.replace('_', ' ')}</span>
            </div>
            <h2 className="text-base font-semibold text-slate-900 mt-1 truncate">
              {document.title}
            </h2>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {document.allowDownload ? (
              <button
                type="button"
                onClick={handleExportText}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                <Download className="w-3.5 h-3.5" />
                Export Text
              </button>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-400 bg-slate-50 border border-slate-200 rounded-lg whitespace-nowrap shrink-0">
                <Lock className="w-3.5 h-3.5" />
                Export Restricted
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-2 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
              aria-label="Close document inspector"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Sub-navigation Tabs */}
        <div className="px-6 py-2.5 border-b border-slate-200 bg-slate-50 flex items-center justify-between gap-4">
          <div className="flex items-center gap-1 p-0.5 bg-slate-200/70 rounded-lg">
            <button
              type="button"
              onClick={() => setTab('evidence')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                tab === 'evidence'
                  ? 'bg-white text-slate-900'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Extracted Pages &amp; Evidence
            </button>
            <button
              type="button"
              onClick={() => setTab('policies')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                tab === 'policies'
                  ? 'bg-white text-slate-900'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              RBAC &amp; Transmission Policy
            </button>
          </div>

          <div className="text-xs text-slate-500 font-mono">
            AI: {document.allowAiQuery ? 'Allowed' : 'Blocked'} · PII Redact:{' '}
            {document.redactPiiOnTransmit ? 'On' : 'Off'}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {tab === 'evidence' ? (
            loading ? (
              <div className="space-y-3">
                <div className="h-24 bg-slate-100 rounded-lg animate-pulse" />
                <div className="h-24 bg-slate-100 rounded-lg animate-pulse" />
              </div>
            ) : chunks.length === 0 ? (
              <p className="text-sm text-slate-500">No text chunks available for this document.</p>
            ) : (
              <div className="space-y-4">
                {chunks.map((chunk) => {
                  const isTargetPage = highlightPage === chunk.pageNumber;
                  return (
                    <div
                      key={chunk.id}
                      className={`border rounded-lg p-4 ${
                        isTargetPage
                          ? 'border-emerald-600 bg-emerald-50/30'
                          : 'border-slate-200 bg-white'
                      }`}
                    >
                      <div className="flex items-center justify-between text-xs text-slate-500 mb-2">
                        <span className="font-mono font-medium text-slate-700 tabular-nums">
                          Page {chunk.pageNumber} · Chunk {chunk.chunkIndex + 1}
                        </span>
                        <span className="font-mono tabular-nums">{chunk.charCount} chars</span>
                      </div>
                      <pre className="whitespace-pre-wrap font-sans text-sm text-slate-800 leading-relaxed">
                        {renderHighlightedText(chunk.text, chunk.pageNumber)}
                      </pre>
                    </div>
                  );
                })}
              </div>
            )
          ) : (
            <form onSubmit={handleSavePolicy} className="space-y-5">
              {!canManage && (
                <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">
                  Read-only policy view. Only the document owner or an Admin can modify permissions.
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">Title</label>
                  <input
                    type="text"
                    disabled={!canManage}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg disabled:bg-slate-50"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">Department</label>
                  <input
                    type="text"
                    disabled={!canManage}
                    value={department}
                    onChange={(e) => setDepartment(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg disabled:bg-slate-50"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Visibility Scope
                  </label>
                  <select
                    disabled={!canManage}
                    value={visibility}
                    onChange={(e) => setVisibility(e.target.value as DocumentVisibility)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white disabled:bg-slate-50"
                  >
                    <option value="private">Private — Owner &amp; Admin</option>
                    <option value="role_restricted">Role-Restricted</option>
                    <option value="organization">Organization-Wide</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Classification
                  </label>
                  <select
                    disabled={!canManage}
                    value={classification}
                    onChange={(e) => setClassification(e.target.value as DocumentClassification)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white disabled:bg-slate-50"
                  >
                    <option value="restricted">Restricted</option>
                    <option value="confidential">Confidential</option>
                    <option value="public_internal">Internal Standard</option>
                  </select>
                </div>
              </div>

              {visibility === 'role_restricted' && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-2">
                    Allowed Roles
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {ALL_ROLES.map((r) => {
                      const active = allowedRoles.includes(r);
                      return (
                        <button
                          key={r}
                          type="button"
                          disabled={!canManage}
                          onClick={() =>
                            setAllowedRoles((prev) =>
                              prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]
                            )
                          }
                          className={`px-3 py-1.5 text-xs font-medium rounded-lg border capitalize whitespace-nowrap shrink-0 ${
                            active
                              ? 'bg-slate-900 text-white border-slate-900'
                              : 'bg-white text-slate-700 border-slate-300'
                          }`}
                        >
                          {r}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Authorized User Emails
                </label>
                <input
                  type="text"
                  disabled={!canManage}
                  value={emailsInput}
                  onChange={(e) => setEmailsInput(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg disabled:bg-slate-50"
                />
              </div>

              <div className="border border-slate-200 rounded-lg p-4 space-y-3 bg-slate-50">
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-900">
                  <Shield className="w-3.5 h-3.5 text-emerald-700" />
                  Granular Transmission Permissions
                </div>

                <label className="flex items-center justify-between text-sm">
                  <span className="text-slate-700">Allow AI Search &amp; Q&amp;A Transmission</span>
                  <input
                    type="checkbox"
                    disabled={!canManage}
                    checked={allowAiQuery}
                    onChange={(e) => setAllowAiQuery(e.target.checked)}
                  />
                </label>

                <label className="flex items-center justify-between text-sm">
                  <span className="text-slate-700">Redact PII Before AI Transmission</span>
                  <input
                    type="checkbox"
                    disabled={!canManage}
                    checked={redactPiiOnTransmit}
                    onChange={(e) => setRedactPiiOnTransmit(e.target.checked)}
                  />
                </label>

                <label className="flex items-center justify-between text-sm">
                  <span className="text-slate-700">Allow Original Text Export</span>
                  <input
                    type="checkbox"
                    disabled={!canManage}
                    checked={allowDownload}
                    onChange={(e) => setAllowDownload(e.target.checked)}
                  />
                </label>

                <label className="flex items-center justify-between text-sm">
                  <span className="text-slate-700">Allow External Share / Webhook</span>
                  <input
                    type="checkbox"
                    disabled={!canManage}
                    checked={allowExternalShare}
                    onChange={(e) => setAllowExternalShare(e.target.checked)}
                  />
                </label>
              </div>

              {policyFeedback && (
                <div className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                  {policyFeedback}
                </div>
              )}

              {canManage && (
                <div className="flex items-center justify-between pt-3 border-t border-slate-200">
                  <button
                    type="button"
                    onClick={handleDelete}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-lg hover:bg-rose-100 whitespace-nowrap shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete Document
                  </button>
                  <button
                    type="submit"
                    disabled={savingPolicy}
                    className="px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    {savingPolicy ? 'Saving...' : 'Save Policies'}
                  </button>
                </div>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
