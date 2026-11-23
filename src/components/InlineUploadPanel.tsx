import React, { useRef, useState } from 'react';
import { FileText, Lock, ShieldCheck, Upload } from 'lucide-react';
import { auth } from '../firebase';
import {
  logAuditEvent,
  resolveEmailsForRoles,
  saveDocumentWithChunks,
} from '../services/knowledgeStore';
import type {
  DocumentClassification,
  DocumentFileType,
  DocumentVisibility,
  RoleGrant,
  UserProfile,
  UserRole,
} from '../types';

interface InlineUploadPanelProps {
  isSignedIn: boolean;
  onRequireSignIn: () => void;
  userUid: string;
  userEmail: string;
  userRole: UserRole;
  roleGrants: RoleGrant[];
  userProfiles: UserProfile[];
  onUploaded: (docId: string, title: string) => void;
}

const ROLE_OPTIONS: Array<{ value: UserRole; label: string }> = [
  { value: 'admin', label: 'Admin' },
  { value: 'manager', label: 'Manager' },
  { value: 'engineering', label: 'Engineering' },
  { value: 'legal', label: 'Legal' },
  { value: 'finance', label: 'Finance' },
  { value: 'viewer', label: 'Viewer' },
];

interface ParseResponsePayload {
  error?: string;
  fileName: string;
  fileType: DocumentFileType;
  fileSize: number;
  pageCount: number;
  extractionMethod: string;
  chunks: Array<{
    chunkIndex: number;
    pageNumber: number;
    sectionTitle: string;
    text: string;
    charCount: number;
  }>;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(new Error('Failed to read file bytes in browser.'));
    reader.readAsDataURL(file);
  });
}

export function InlineUploadPanel({
  isSignedIn,
  onRequireSignIn,
  userUid,
  userEmail,
  userRole,
  roleGrants,
  userProfiles,
  onUploaded,
}: InlineUploadPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [title, setTitle] = useState('');
  const [department, setDepartment] = useState('Operations');
  const [classification, setClassification] = useState<DocumentClassification>('confidential');
  const [visibility, setVisibility] = useState<DocumentVisibility>('private');
  const [allowedRoles, setAllowedRoles] = useState<UserRole[]>(['admin']);
  const [emailsInput, setEmailsInput] = useState('');
  const [allowAiQuery, setAllowAiQuery] = useState(true);
  const [allowDownload, setAllowDownload] = useState(true);
  const [redactPiiOnTransmit, setRedactPiiOnTransmit] = useState(true);
  const [allowExternalShare, setAllowExternalShare] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const handleFileChoose = (file: File | undefined) => {
    if (!file) return;
    setErrorMessage('');
    setSelectedFile(file);
    if (!title.trim()) {
      setTitle(file.name.replace(/\.[^/.]+$/, ''));
    }
  };

  const toggleRole = (role: UserRole) => {
    setAllowedRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]
    );
  };

  const parseFileOnServer = async (file: File, idToken: string): Promise<ParseResponsePayload> => {
    try {
      const formData = new FormData();
      formData.append('file', file);
      const parseResp = await fetch('/api/documents/parse', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${idToken}`,
        },
        body: formData,
      });

      const contentType = parseResp.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const json = (await parseResp.json()) as ParseResponsePayload;
        if (!parseResp.ok) {
          throw new Error(json.error || `Document parsing failed (HTTP ${parseResp.status}).`);
        }
        return json;
      }
      if (!parseResp.ok) {
        throw new Error(`Document parsing failed (HTTP ${parseResp.status}).`);
      }
    } catch (primaryErr) {
      const msg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
      const isNetworkFailure =
        primaryErr instanceof TypeError ||
        msg.toLowerCase().includes('failed to fetch') ||
        msg.toLowerCase().includes('network');
      if (!isNetworkFailure) {
        throw primaryErr;
      }
    }

    const base64Data = await fileToBase64(file);
    const fallbackResp = await fetch('/api/documents/parse-base64', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        fileName: file.name,
        base64Data,
      }),
    });

    const fallbackData = (await fallbackResp.json()) as ParseResponsePayload;
    if (!fallbackResp.ok) {
      throw new Error(fallbackData.error || 'Failed to parse uploaded document.');
    }
    return fallbackData;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSignedIn || !auth.currentUser) {
      onRequireSignIn();
      return;
    }

    if (!selectedFile) {
      setErrorMessage('Select a PDF, TXT, MD, CSV, or JSON document first.');
      return;
    }

    setSubmitting(true);
    setErrorMessage('');
    setStatusMessage('Extracting text page by page...');

    try {
      const idToken = await auth.currentUser.getIdToken(true);
      const parseData = await parseFileOnServer(selectedFile, idToken);

      setStatusMessage(
        `Indexed ${parseData.pageCount} page(s) into ${parseData.chunks.length} verified chunk(s). Saving to vault...`
      );

      const explicitEmails = emailsInput
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.includes('@'));

      const effectiveRoles: UserRole[] =
        visibility === 'private'
          ? []
          : visibility === 'organization'
            ? ['admin', 'manager', 'engineering', 'legal', 'finance', 'viewer']
            : allowedRoles;

      const resolvedEmails =
        visibility === 'private'
          ? explicitEmails
          : resolveEmailsForRoles(effectiveRoles, explicitEmails, roleGrants, userProfiles);

      const docTitle = title.trim() || parseData.fileName;
      const docId = await saveDocumentWithChunks({
        title: docTitle,
        fileName: parseData.fileName,
        fileType: parseData.fileType,
        fileSize: parseData.fileSize,
        pageCount: parseData.pageCount,
        department,
        classification,
        visibility,
        allowedRoles: effectiveRoles,
        allowedEmails: resolvedEmails,
        allowAiQuery,
        allowDownload,
        redactPiiOnTransmit,
        allowExternalShare,
        sourceType: 'manual_upload',
        sourceConnectorId: '',
        ownerId: userUid,
        ownerEmail: userEmail,
        chunks: parseData.chunks,
      });

      await logAuditEvent({
        actorUid: userUid,
        actorEmail: userEmail,
        actorRole: userRole,
        action: 'document_upload',
        targetId: docId,
        targetTitle: docTitle,
        details: `Uploaded ${parseData.fileName} (${parseData.pageCount} pages, ${parseData.chunks.length} chunks, ${parseData.extractionMethod}). Visibility: ${visibility}. AI Query: ${allowAiQuery}. PII Redact: ${redactPiiOnTransmit}.`,
        piiRedacted: redactPiiOnTransmit,
      });

      setSelectedFile(null);
      setTitle('');
      setEmailsInput('');
      setStatusMessage(`Indexed "${docTitle}" and enforced RBAC policy.`);
      onUploaded(docId, docTitle);
    } catch (err) {
      let readable = err instanceof Error ? err.message : 'Upload failed.';
      try {
        const parsedErr = JSON.parse(readable) as { error?: string };
        if (parsedErr?.error) readable = parsedErr.error;
      } catch {
        // plain error message
      }
      setErrorMessage(readable);
      setStatusMessage('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-4">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">
            Upload &amp; Index Enterprise Documents
          </h3>
          <p className="text-sm text-slate-600 mt-0.5">
            Drop PDF, TXT, Markdown, CSV, or JSON files to index verbatim page chunks with RBAC &amp; PII policies.
          </p>
        </div>
        {!isSignedIn && (
          <button
            type="button"
            onClick={onRequireSignIn}
            className="px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            Sign in to Upload
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Dropzone + File Metadata */}
        <div className="lg:col-span-6 space-y-4">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              handleFileChoose(e.dataTransfer.files?.[0]);
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
              dragOver
                ? 'border-emerald-600 bg-emerald-50/60'
                : 'border-slate-300 bg-slate-50 hover:border-slate-400'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.txt,.md,.csv,.json"
              className="hidden"
              onChange={(e) => handleFileChoose(e.target.files?.[0])}
            />
            {selectedFile ? (
              <div className="flex items-center justify-center gap-3 text-slate-900">
                <FileText className="w-6 h-6 text-emerald-700 shrink-0" />
                <div className="text-left">
                  <p className="text-sm font-semibold text-slate-900">{selectedFile.name}</p>
                  <p className="text-xs text-slate-600 font-mono tabular-nums">
                    {(selectedFile.size / 1024).toFixed(1)} KB
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Upload className="w-7 h-7 text-slate-700 mx-auto" />
                <p className="text-sm font-semibold text-slate-900">
                  Drop your PDF or document here, or click to browse
                </p>
                <p className="text-xs text-slate-600">
                  PDF, TXT, Markdown, CSV, JSON up to 20 MB
                </p>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-800 mb-1.5">
                Document Title
              </label>
              <input
                type="text"
                required={Boolean(selectedFile)}
                maxLength={200}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Vendor MSA Contract 2026"
                className="w-full px-3 py-2 text-sm text-slate-900 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-700"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-800 mb-1.5">
                Department
              </label>
              <input
                type="text"
                required
                maxLength={80}
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                placeholder="e.g. Legal, Engineering"
                className="w-full px-3 py-2 text-sm text-slate-900 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-700"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-800 mb-1.5">
                Access Scope (RBAC)
              </label>
              <select
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as DocumentVisibility)}
                className="w-full px-3 py-2 text-sm text-slate-900 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-700"
              >
                <option value="private">Private — Only Me &amp; Admin</option>
                <option value="role_restricted">Role-Restricted — Selected Roles</option>
                <option value="organization">Organization-Wide</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-800 mb-1.5">
                Classification
              </label>
              <select
                value={classification}
                onChange={(e) => setClassification(e.target.value as DocumentClassification)}
                className="w-full px-3 py-2 text-sm text-slate-900 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-700"
              >
                <option value="restricted">Restricted</option>
                <option value="confidential">Confidential</option>
                <option value="public_internal">Internal Standard</option>
              </select>
            </div>
          </div>
        </div>

        {/* Right: RBAC & Transmission Controls */}
        <div className="lg:col-span-6 space-y-4 flex flex-col justify-between">
          <div className="space-y-4">
            {visibility === 'role_restricted' && (
              <div>
                <label className="block text-sm font-medium text-slate-800 mb-2">
                  Authorized Roles
                </label>
                <div className="flex flex-wrap gap-2">
                  {ROLE_OPTIONS.map((roleOpt) => {
                    const active = allowedRoles.includes(roleOpt.value);
                    return (
                      <button
                        key={roleOpt.value}
                        type="button"
                        onClick={() => toggleRole(roleOpt.value)}
                        className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                          active
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'bg-white text-slate-800 border-slate-300 hover:bg-slate-50'
                        }`}
                      >
                        {roleOpt.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-slate-800 mb-1.5">
                Specific Authorized Emails (comma-separated, optional)
              </label>
              <input
                type="text"
                value={emailsInput}
                onChange={(e) => setEmailsInput(e.target.value)}
                placeholder="colleague@company.com, legal@company.com"
                className="w-full px-3 py-2 text-sm text-slate-900 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-700"
              />
            </div>

            <div className="border border-slate-200 rounded-xl p-4 bg-slate-50 space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <Lock className="w-4 h-4 text-emerald-700" />
                Granular Data Transmission Controls
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={allowAiQuery}
                    onChange={(e) => setAllowAiQuery(e.target.checked)}
                    className="mt-1 rounded border-slate-300 text-emerald-700"
                  />
                  <span>
                    <strong className="block text-slate-900 font-medium">Allow AI Search</strong>
                    <span className="text-xs text-slate-600">Permit authorized queries</span>
                  </span>
                </label>

                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={redactPiiOnTransmit}
                    onChange={(e) => setRedactPiiOnTransmit(e.target.checked)}
                    className="mt-1 rounded border-slate-300 text-emerald-700"
                  />
                  <span>
                    <strong className="block text-slate-900 font-medium">Redact PII Before Transmit</strong>
                    <span className="text-xs text-slate-600">Mask emails, phones &amp; SSNs</span>
                  </span>
                </label>

                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={allowDownload}
                    onChange={(e) => setAllowDownload(e.target.checked)}
                    className="mt-1 rounded border-slate-300 text-emerald-700"
                  />
                  <span>
                    <strong className="block text-slate-900 font-medium">Allow Text Export</strong>
                    <span className="text-xs text-slate-600">Permit authorized text download</span>
                  </span>
                </label>

                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={allowExternalShare}
                    onChange={(e) => setAllowExternalShare(e.target.checked)}
                    className="mt-1 rounded border-slate-300 text-emerald-700"
                  />
                  <span>
                    <strong className="block text-slate-900 font-medium">Allow External Share</strong>
                    <span className="text-xs text-slate-600">Permit outbound webhook push</span>
                  </span>
                </label>
              </div>
            </div>
          </div>

          <div className="space-y-3 pt-2">
            {statusMessage && (
              <div className="flex items-center gap-2 text-sm text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2.5">
                <ShieldCheck className="w-4 h-4 shrink-0 text-emerald-700" />
                <span>{statusMessage}</span>
              </div>
            )}

            {errorMessage && (
              <div className="text-sm text-rose-900 bg-rose-50 border border-rose-200 rounded-lg px-4 py-2.5">
                {errorMessage}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 px-5 text-sm font-semibold text-white bg-slate-900 rounded-xl hover:bg-slate-800 disabled:opacity-50 transition-colors"
            >
              {submitting
                ? 'Indexing Document...'
                : isSignedIn
                  ? 'Ingest & Enforce Policies'
                  : 'Sign In & Ingest Document'}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
