import React, { useState } from 'react';
import { Globe, Link2, PauseCircle, PlayCircle, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { auth } from '../firebase';
import {
  createConnectorRecord,
  deleteConnectorRecord,
  logAuditEvent,
  markConnectorSynced,
  resolveEmailsForRoles,
  saveDocumentWithChunks,
  toggleConnectorStatus,
} from '../services/knowledgeStore';
import type {
  DocumentVisibility,
  EnterpriseConnector,
  RoleGrant,
  UserProfile,
  UserRole,
} from '../types';

interface ConnectorsViewProps {
  connectors: EnterpriseConnector[];
  userUid: string;
  userEmail: string;
  effectiveRole: UserRole;
  roleGrants: RoleGrant[];
  userProfiles: UserProfile[];
  onSyncedDocument: (title: string) => void;
}

const PROVIDERS: Array<{ value: EnterpriseConnector['provider']; label: string; desc: string }> = [
  { value: 'confluence', label: 'Confluence / Wiki Feed', desc: 'Sync HTML, JSON, or exported wiki pages' },
  { value: 'notion', label: 'Notion Workspace', desc: 'Ingest Notion markdown exports or public API feeds' },
  { value: 'slack', label: 'Slack Channel Digest', desc: 'Import channel JSON exports into searchable knowledge' },
  { value: 'webhook', label: 'REST / JSON Endpoint', desc: 'Pull structured JSON or plain-text feeds over HTTPS' },
];

export function ConnectorsView({
  connectors,
  userUid,
  userEmail,
  effectiveRole,
  roleGrants,
  userProfiles,
  onSyncedDocument,
}: ConnectorsViewProps) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<EnterpriseConnector['provider']>('confluence');
  const [endpointUrl, setEndpointUrl] = useState('');
  const [defaultVisibility, setDefaultVisibility] = useState<DocumentVisibility>('role_restricted');
  const [defaultRoles, setDefaultRoles] = useState<UserRole[]>(['admin', 'engineering']);
  const [allowAiQuery, setAllowAiQuery] = useState(true);
  const [redactPiiOnTransmit, setRedactPiiOnTransmit] = useState(true);
  const [creating, setCreating] = useState(false);

  // Sync modal state
  const [activeConnector, setActiveConnector] = useState<EnterpriseConnector | null>(null);
  const [syncTitle, setSyncTitle] = useState('');
  const [syncUrl, setSyncUrl] = useState('');
  const [rawPayload, setRawPayload] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');

  const handleCreateConnector = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      const id = await createConnectorRecord({
        name,
        provider,
        endpointUrl,
        defaultVisibility,
        defaultAllowedRoles: defaultRoles,
        allowAiQuery,
        redactPiiOnTransmit,
        ownerId: userUid,
      });
      await logAuditEvent({
        actorUid: userUid,
        actorEmail: userEmail,
        actorRole: effectiveRole,
        action: 'connector_sync',
        targetId: id,
        targetTitle: name,
        details: `Created ${provider} connector with default visibility ${defaultVisibility} and PII redaction ${redactPiiOnTransmit}.`,
        piiRedacted: redactPiiOnTransmit,
      });
      setName('');
      setEndpointUrl('');
      setShowForm(false);
    } finally {
      setCreating(false);
    }
  };

  const openSyncDialog = (conn: EnterpriseConnector) => {
    setActiveConnector(conn);
    setSyncTitle(`${conn.name} Snapshot`);
    setSyncUrl(conn.endpointUrl);
    setRawPayload('');
    setSyncError('');
  };

  const handleRunSync = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeConnector || !auth.currentUser) return;

    setSyncing(true);
    setSyncError('');
    try {
      const token = await auth.currentUser.getIdToken();
      const resp = await fetch('/api/connectors/fetch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: syncTitle,
          url: rawPayload.trim() ? undefined : syncUrl.trim() || undefined,
          rawContent: rawPayload.trim() || undefined,
        }),
      });

      const data = (await resp.json()) as {
        error?: string;
        title: string;
        pageCount: number;
        fileSize: number;
        chunks: Array<{
          chunkIndex: number;
          pageNumber: number;
          sectionTitle: string;
          text: string;
          charCount: number;
        }>;
      };

      if (!resp.ok) {
        throw new Error(data.error || 'Connector sync failed.');
      }

      const resolvedEmails =
        activeConnector.defaultVisibility === 'private'
          ? []
          : resolveEmailsForRoles(
              activeConnector.defaultAllowedRoles,
              [],
              roleGrants,
              userProfiles
            );

      const docId = await saveDocumentWithChunks({
        title: data.title,
        fileName: `${activeConnector.provider}_${Date.now()}.txt`,
        fileType: 'connector',
        fileSize: data.fileSize,
        pageCount: data.pageCount,
        department: activeConnector.provider.toUpperCase(),
        classification: 'confidential',
        visibility: activeConnector.defaultVisibility,
        allowedRoles: activeConnector.defaultAllowedRoles,
        allowedEmails: resolvedEmails,
        allowAiQuery: activeConnector.allowAiQuery,
        allowDownload: true,
        redactPiiOnTransmit: activeConnector.redactPiiOnTransmit,
        allowExternalShare: false,
        sourceType: activeConnector.provider,
        sourceConnectorId: activeConnector.id,
        ownerId: userUid,
        ownerEmail: userEmail,
        chunks: data.chunks,
      });

      await markConnectorSynced(activeConnector.id, activeConnector.syncedDocCount + 1);
      await logAuditEvent({
        actorUid: userUid,
        actorEmail: userEmail,
        actorRole: effectiveRole,
        action: 'connector_sync',
        targetId: docId,
        targetTitle: data.title,
        details: `Synced ${data.chunks.length} chunk(s) from ${activeConnector.name} (${activeConnector.provider}).`,
        piiRedacted: activeConnector.redactPiiOnTransmit,
      });

      onSyncedDocument(data.title);
      setActiveConnector(null);
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : 'Sync failed.');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            External Tool Connectors
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Integrate Confluence, Notion, Slack exports, or authenticated HTTPS feeds with inherited RBAC policies.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
        >
          <Plus className="w-4 h-4" />
          New Connector
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={handleCreateConnector}
          className="bg-white border border-slate-200 rounded-xl p-6 space-y-4"
        >
          <h3 className="text-sm font-semibold text-slate-900">Configure Tool Integration</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Connector Name
              </label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Engineering Runbooks"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Provider</label>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value as EnterpriseConnector['provider'])}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                {PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Source HTTPS URL (optional)
              </label>
              <input
                type="url"
                value={endpointUrl}
                onChange={(e) => setEndpointUrl(e.target.value)}
                placeholder="https://docs.company.com/feed.json"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Default Document Visibility
              </label>
              <select
                value={defaultVisibility}
                onChange={(e) => setDefaultVisibility(e.target.value as DocumentVisibility)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="private">Private — Owner &amp; Admin</option>
                <option value="role_restricted">Role-Restricted</option>
                <option value="organization">Organization-Wide</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Default Authorized Roles
              </label>
              <div className="flex flex-wrap gap-1.5">
                {(['admin', 'manager', 'engineering', 'legal', 'finance', 'viewer'] as UserRole[]).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() =>
                      setDefaultRoles((prev) =>
                        prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]
                      )
                    }
                    className={`px-2.5 py-1 text-xs font-medium rounded-md border capitalize whitespace-nowrap shrink-0 ${
                      defaultRoles.includes(r)
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-600 border-slate-300'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-6 text-xs text-slate-700 pt-1">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={allowAiQuery}
                onChange={(e) => setAllowAiQuery(e.target.checked)}
              />
              Enable AI Q&amp;A on synced records
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={redactPiiOnTransmit}
                onChange={(e) => setRedactPiiOnTransmit(e.target.checked)}
              />
              Redact PII prior to AI transmission
            </label>
          </div>

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-200">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creating}
              className="px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              {creating ? 'Saving...' : 'Save Connector'}
            </button>
          </div>
        </form>
      )}

      {/* Connectors Grid */}
      {connectors.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-3">
          <Link2 className="w-7 h-7 text-slate-400 mx-auto" />
          <h3 className="text-sm font-semibold text-slate-900">No External Connectors Configured</h3>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            Connect an external Confluence, Notion, Slack export, or HTTPS JSON/Markdown source to ingest knowledge records under strict RBAC policies.
          </p>
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            Add First Connector
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {connectors.map((conn) => (
            <div
              key={conn.id}
              className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4"
            >
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <Globe className="w-3.5 h-3.5" />
                      <span className="capitalize">{conn.provider}</span>
                      <span aria-hidden="true">·</span>
                      <span className={conn.status === 'active' ? 'text-emerald-700 font-medium' : 'text-amber-700 font-medium'}>
                        {conn.status === 'active' ? 'Active' : 'Paused'}
                      </span>
                    </div>
                    <h3 className="text-base font-semibold text-slate-900 mt-1">{conn.name}</h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => deleteConnectorRecord(conn.id)}
                    className="p-1.5 text-slate-400 hover:text-rose-700 rounded-lg hover:bg-rose-50"
                    title="Delete connector"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                {conn.endpointUrl && (
                  <p className="text-xs text-slate-500 font-mono truncate">{conn.endpointUrl}</p>
                )}

                <div className="text-xs text-slate-600 flex flex-wrap gap-x-3 gap-y-1 pt-1">
                  <span>Scope: {conn.defaultVisibility.replace('_', ' ')}</span>
                  <span aria-hidden="true">·</span>
                  <span>PII Redact: {conn.redactPiiOnTransmit ? 'Enabled' : 'Disabled'}</span>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">Synced Docs: {conn.syncedDocCount}</span>
                </div>
                <p className="text-xs text-slate-400 font-mono tabular-nums">
                  Last Sync: {conn.lastSyncedAt}
                </p>
              </div>

              <div className="flex items-center justify-between gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() =>
                    toggleConnectorStatus(conn.id, conn.status === 'active' ? 'paused' : 'active')
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0"
                >
                  {conn.status === 'active' ? (
                    <>
                      <PauseCircle className="w-3.5 h-3.5" />
                      Pause
                    </>
                  ) : (
                    <>
                      <PlayCircle className="w-3.5 h-3.5" />
                      Resume
                    </>
                  )}
                </button>

                <button
                  type="button"
                  disabled={conn.status !== 'active'}
                  onClick={() => openSyncDialog(conn)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap shrink-0"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Sync Knowledge Now
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Sync Payload / Fetch Modal */}
      {activeConnector && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleRunSync}
            className="bg-white border border-slate-200 rounded-xl w-full max-w-lg p-6 space-y-4"
          >
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                Sync from {activeConnector.name}
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Fetch live content from an HTTPS endpoint or paste exported Markdown/JSON/Slack digest text below.
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Record Title
              </label>
              <input
                type="text"
                required
                value={syncTitle}
                onChange={(e) => setSyncTitle(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Live Source HTTPS URL (SSRF-guarded)
              </label>
              <input
                type="url"
                value={syncUrl}
                onChange={(e) => setSyncUrl(e.target.value)}
                placeholder="https://example.com/api/knowledge.json"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Or Paste Exported Tool Content (Markdown / JSON / Notes)
              </label>
              <textarea
                rows={5}
                value={rawPayload}
                onChange={(e) => setRawPayload(e.target.value)}
                placeholder="Paste Confluence page, Notion export, or Slack digest text here..."
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
              />
            </div>

            {syncError && (
              <div className="text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
                {syncError}
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-200">
              <button
                type="button"
                onClick={() => setActiveConnector(null)}
                className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={syncing}
                className="px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50"
              >
                {syncing ? 'Ingesting...' : 'Ingest & Index'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
