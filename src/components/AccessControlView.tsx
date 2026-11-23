import React, { useState } from 'react';
import { Lock, Plus, ShieldCheck, Trash2, UserCheck } from 'lucide-react';
import {
  logAuditEvent,
  removeRoleGrant,
  updateDocumentPolicies,
  updateUserProfileRole,
  upsertRoleGrant,
} from '../services/knowledgeStore';
import type {
  AuditLogEntry,
  KnowledgeDocument,
  RoleGrant,
  UserProfile,
  UserRole,
} from '../types';

interface AccessControlViewProps {
  mode: 'rbac' | 'audit';
  isTrueAdmin: boolean;
  userUid: string;
  userEmail: string;
  effectiveRole: UserRole;
  roleGrants: RoleGrant[];
  userProfiles: UserProfile[];
  documents: KnowledgeDocument[];
  auditLogs: AuditLogEntry[];
  onInspectDocument: (doc: KnowledgeDocument) => void;
}

const ROLES: UserRole[] = ['admin', 'manager', 'engineering', 'legal', 'finance', 'viewer'];

export function AccessControlView({
  mode,
  isTrueAdmin,
  userUid,
  userEmail,
  effectiveRole,
  roleGrants,
  userProfiles,
  documents,
  auditLogs,
  onInspectDocument,
}: AccessControlViewProps) {
  const [grantEmail, setGrantEmail] = useState('');
  const [grantName, setGrantName] = useState('');
  const [grantRole, setGrantRole] = useState<UserRole>('engineering');
  const [grantDept, setGrantDept] = useState('Engineering');
  const [canUpload, setCanUpload] = useState(true);
  const [canManageConnectors, setCanManageConnectors] = useState(false);
  const [canExport, setCanExport] = useState(true);
  const [savingGrant, setSavingGrant] = useState(false);
  const [grantError, setGrantError] = useState('');

  const handleGrantSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isTrueAdmin) return;
    setGrantError('');
    setSavingGrant(true);
    try {
      const id = await upsertRoleGrant({
        email: grantEmail,
        displayName: grantName || grantEmail.split('@')[0],
        role: grantRole,
        department: grantDept,
        canUpload,
        canManageConnectors,
        canExport,
        grantedBy: userUid,
      });

      const matchedProfile = userProfiles.find(
        (p) => p.email.toLowerCase() === grantEmail.trim().toLowerCase()
      );
      if (matchedProfile) {
        await updateUserProfileRole(matchedProfile.uid, grantRole, grantDept);
      }

      await logAuditEvent({
        actorUid: userUid,
        actorEmail: userEmail,
        actorRole: effectiveRole,
        action: 'role_grant',
        targetId: id,
        targetTitle: grantEmail.trim().toLowerCase(),
        details: `Assigned role '${grantRole}' (${grantDept}) — Upload: ${canUpload}, Connectors: ${canManageConnectors}, Export: ${canExport}.`,
        piiRedacted: false,
      });

      setGrantEmail('');
      setGrantName('');
    } catch (err) {
      setGrantError(err instanceof Error ? err.message : 'Failed to save role grant.');
    } finally {
      setSavingGrant(false);
    }
  };

  const handleQuickToggle = async (
    docItem: KnowledgeDocument,
    field: 'allowAiQuery' | 'redactPiiOnTransmit' | 'allowDownload' | 'allowExternalShare'
  ) => {
    const canManage = isTrueAdmin || docItem.ownerId === userUid;
    if (!canManage) return;
    const nextVal = !docItem[field];
    await updateDocumentPolicies(docItem.id, {
      title: docItem.title,
      department: docItem.department,
      classification: docItem.classification,
      visibility: docItem.visibility,
      allowedRoles: docItem.allowedRoles,
      allowedEmails: docItem.allowedEmails,
      allowAiQuery: field === 'allowAiQuery' ? nextVal : docItem.allowAiQuery,
      allowDownload: field === 'allowDownload' ? nextVal : docItem.allowDownload,
      redactPiiOnTransmit:
        field === 'redactPiiOnTransmit' ? nextVal : docItem.redactPiiOnTransmit,
      allowExternalShare:
        field === 'allowExternalShare' ? nextVal : docItem.allowExternalShare,
    });

    await logAuditEvent({
      actorUid: userUid,
      actorEmail: userEmail,
      actorRole: effectiveRole,
      action: 'policy_update',
      targetId: docItem.id,
      targetTitle: docItem.title,
      details: `Toggled ${field} to ${nextVal}.`,
      piiRedacted: field === 'redactPiiOnTransmit' ? nextVal : docItem.redactPiiOnTransmit,
    });
  };

  if (mode === 'audit') {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            Security &amp; Transmission Audit Log
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Immutable record of document uploads, AI Q&amp;A transmissions, policy updates, and role assignments.
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {auditLogs.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500">
              No audit events recorded yet. Upload a document or run a grounded query to begin logging.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                    <th className="py-2.5 px-4">Timestamp</th>
                    <th className="py-2.5 px-4">Actor</th>
                    <th className="py-2.5 px-4">Action</th>
                    <th className="py-2.5 px-4">Target</th>
                    <th className="py-2.5 px-4">Details</th>
                    <th className="py-2.5 px-4 text-right">PII Guard</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {auditLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-slate-50/70">
                      <td className="py-2.5 px-4 font-mono text-slate-500 tabular-nums whitespace-nowrap">
                        {log.createdAt?.toDate
                          ? log.createdAt.toDate().toISOString().slice(0, 19).replace('T', ' ')
                          : 'Pending'}
                      </td>
                      <td className="py-2.5 px-4 text-slate-900">
                        <span className="font-medium">{log.actorEmail}</span>
                        <span className="text-slate-400 ml-1.5">({log.actorRole})</span>
                      </td>
                      <td className="py-2.5 px-4 font-mono text-slate-700 whitespace-nowrap">
                        {log.action}
                      </td>
                      <td className="py-2.5 px-4 font-medium text-slate-900 max-w-[180px] truncate">
                        {log.targetTitle}
                      </td>
                      <td className="py-2.5 px-4 text-slate-600 max-w-md">{log.details}</td>
                      <td className="py-2.5 px-4 text-right font-mono whitespace-nowrap">
                        {log.piiRedacted ? (
                          <span className="text-emerald-700 font-medium">Redacted</span>
                        ) : (
                          <span className="text-slate-400">Standard</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">
          Role-Based Access Control &amp; Granular Transmission Matrix
        </h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Authorize enterprise members by role and enforce per-document AI query, PII redaction, and export permissions.
        </p>
      </div>

      {/* Section 1: Team Role Grants */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <UserCheck className="w-4 h-4 text-slate-700" />
            <h3 className="text-sm font-semibold text-slate-900">
              Authorized Member Role Directory
            </h3>
          </div>
          <span className="text-xs text-slate-500 font-mono tabular-nums">
            {roleGrants.length} granted member(s)
          </span>
        </div>

        {isTrueAdmin && (
          <form
            onSubmit={handleGrantSubmit}
            className="p-5 bg-slate-50 border-b border-slate-200 space-y-4"
          >
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <input
                type="email"
                required
                value={grantEmail}
                onChange={(e) => setGrantEmail(e.target.value)}
                placeholder="colleague@company.com"
                className="px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
              />
              <input
                type="text"
                value={grantName}
                onChange={(e) => setGrantName(e.target.value)}
                placeholder="Full Name"
                className="px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
              />
              <select
                value={grantRole}
                onChange={(e) => setGrantRole(e.target.value as UserRole)}
                className="px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg capitalize"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <input
                type="text"
                required
                value={grantDept}
                onChange={(e) => setGrantDept(e.target.value)}
                placeholder="Department"
                className="px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-5 text-xs text-slate-700">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={canUpload}
                    onChange={(e) => setCanUpload(e.target.checked)}
                  />
                  Can Upload Documents
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={canManageConnectors}
                    onChange={(e) => setCanManageConnectors(e.target.checked)}
                  />
                  Can Manage Connectors
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={canExport}
                    onChange={(e) => setCanExport(e.target.checked)}
                  />
                  Can Export Text
                </label>
              </div>

              <button
                type="submit"
                disabled={savingGrant}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                {savingGrant ? 'Assigning...' : 'Assign Role Grant'}
              </button>
            </div>
            {grantError && (
              <p className="text-xs text-rose-700">{grantError}</p>
            )}
          </form>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                <th className="py-2.5 px-4">Member Email</th>
                <th className="py-2.5 px-4">Role</th>
                <th className="py-2.5 px-4">Department</th>
                <th className="py-2.5 px-4">Capabilities</th>
                {isTrueAdmin && <th className="py-2.5 px-4 text-right">Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {roleGrants.length === 0 ? (
                <tr>
                  <td colSpan={isTrueAdmin ? 5 : 4} className="py-6 px-4 text-center text-slate-500">
                    No additional role grants assigned yet. Your verified admin account holds full governance privileges.
                  </td>
                </tr>
              ) : (
                roleGrants.map((g) => (
                  <tr key={g.id} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-4">
                      <span className="font-medium text-slate-900">{g.email}</span>
                      <span className="text-slate-400 ml-2">{g.displayName}</span>
                    </td>
                    <td className="py-2.5 px-4 capitalize font-medium text-slate-800">{g.role}</td>
                    <td className="py-2.5 px-4 text-slate-600">{g.department}</td>
                    <td className="py-2.5 px-4 text-slate-600">
                      {[
                        g.canUpload ? 'Upload' : null,
                        g.canManageConnectors ? 'Connectors' : null,
                        g.canExport ? 'Export' : null,
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'Read-only'}
                    </td>
                    {isTrueAdmin && (
                      <td className="py-2.5 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => removeRoleGrant(g.id)}
                          className="p-1 text-slate-400 hover:text-rose-700"
                          title="Revoke grant"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Section 2: Document Transmission Matrix */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-emerald-700" />
            <h3 className="text-sm font-semibold text-slate-900">
              Per-Document Transmission &amp; RBAC Matrix
            </h3>
          </div>
          <span className="text-xs text-slate-500 font-mono tabular-nums">
            {documents.length} authorized document(s)
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                <th className="py-2.5 px-4">Document</th>
                <th className="py-2.5 px-4">Scope &amp; Roles</th>
                <th className="py-2.5 px-4 text-center">AI Query</th>
                <th className="py-2.5 px-4 text-center">Redact PII</th>
                <th className="py-2.5 px-4 text-center">Export</th>
                <th className="py-2.5 px-4 text-center">Ext Share</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {documents.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 px-4 text-center text-slate-500">
                    No documents in scope for the current role.
                  </td>
                </tr>
              ) : (
                documents.map((docItem) => {
                  const canEdit = isTrueAdmin || docItem.ownerId === userUid;
                  return (
                    <tr key={docItem.id} className="hover:bg-slate-50/70">
                      <td className="py-2.5 px-4">
                        <button
                          type="button"
                          onClick={() => onInspectDocument(docItem)}
                          className="font-medium text-slate-900 hover:text-emerald-700 text-left"
                        >
                          {docItem.title}
                        </button>
                        <div className="text-slate-400 font-mono tabular-nums mt-0.5">
                          {docItem.fileName} · {docItem.pageCount}p
                        </div>
                      </td>
                      <td className="py-2.5 px-4 text-slate-600">
                        <span className="capitalize font-medium text-slate-800">
                          {docItem.visibility.replace('_', ' ')}
                        </span>
                        {docItem.allowedRoles.length > 0 && (
                          <span className="text-slate-400 ml-1.5">
                            ({docItem.allowedRoles.join(', ')})
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-4 text-center">
                        <input
                          type="checkbox"
                          disabled={!canEdit}
                          checked={docItem.allowAiQuery}
                          onChange={() => handleQuickToggle(docItem, 'allowAiQuery')}
                          aria-label={`Allow AI query for ${docItem.title}`}
                        />
                      </td>
                      <td className="py-2.5 px-4 text-center">
                        <input
                          type="checkbox"
                          disabled={!canEdit}
                          checked={docItem.redactPiiOnTransmit}
                          onChange={() => handleQuickToggle(docItem, 'redactPiiOnTransmit')}
                          aria-label={`Redact PII for ${docItem.title}`}
                        />
                      </td>
                      <td className="py-2.5 px-4 text-center">
                        <input
                          type="checkbox"
                          disabled={!canEdit}
                          checked={docItem.allowDownload}
                          onChange={() => handleQuickToggle(docItem, 'allowDownload')}
                          aria-label={`Allow export for ${docItem.title}`}
                        />
                      </td>
                      <td className="py-2.5 px-4 text-center">
                        <input
                          type="checkbox"
                          disabled={!canEdit}
                          checked={docItem.allowExternalShare}
                          onChange={() => handleQuickToggle(docItem, 'allowExternalShare')}
                          aria-label={`Allow external share for ${docItem.title}`}
                        />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-start gap-2.5 text-xs text-slate-500 bg-white border border-slate-200 rounded-xl p-4">
        <ShieldCheck className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
        <p>
          Documents with <strong>Allow AI Query</strong> unchecked remain accessible to authorized human readers in the Document Vault, but are strictly blocked from transmission to the AI search &amp; Q&amp;A layer.
        </p>
      </div>
    </div>
  );
}
