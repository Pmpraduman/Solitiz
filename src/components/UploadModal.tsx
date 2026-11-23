import React, { useRef, useState } from 'react';
import { FileText, Lock, ShieldCheck, Upload, X } from 'lucide-react';
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

interface UploadModalProps {
  open: boolean;
  onClose: () => void;
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

export function UploadModal({
  open,
  onClose,
  userUid,
  userEmail,
  userRole,
  roleGrants,
  userProfiles,
  onUploaded,
}: UploadModalProps) {
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

  if (!open) return null;

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
    // Primary attempt: multipart/form-data
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
      // Fallback to JSON base64 transport if multipart network transport failed
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
    if (!selectedFile) {
      setErrorMessage('Select a PDF, TXT, MD, CSV, or JSON document first.');
      return;
    }

    const currentUser = auth.currentUser;
    if (!currentUser) {
      setErrorMessage('Active authentication session required. Please sign in again.');
      return;
    }

    setSubmitting(true);
    setErrorMessage('');
    setStatusMessage('Extracting text page by page...');

    try {
      const idToken = await currentUser.getIdToken(true);
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

      onUploaded(docId, docTitle);
      setSelectedFile(null);
      setTitle('');
      setEmailsInput('');
      setStatusMessage('');
      onClose();
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
    <div className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Upload Document to Knowledge Vault
            </h2>
            <p className="text-sm text-slate-600 mt-0.5">
              Extracts exact page-numbered text for zero-hallucination search.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="p-2 text-slate-600 hover:text-slate-900 rounded-lg hover:bg-slate-100 transition-colors"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {/* File Dropzone */}
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
            className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
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
                <p className="text-sm text-slate-600">
                  Supports PDF, TXT, Markdown, CSV, JSON up to 20 MB
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
                required
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
                placeholder="e.g. Legal, Engineering, Personal"
                className="w-full px-3 py-2 text-sm text-slate-900 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-700"
              />
            </div>
          </div>

          {/* RBAC Visibility & Classification */}
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
                <option value="organization">Organization-Wide — All Verified Users</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-800 mb-1.5">
                Security Classification
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

          {/* Granular Data Transmission Controls */}
          <div className="border border-slate-200 rounded-lg p-4 bg-slate-50 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Lock className="w-4 h-4 text-emerald-700" />
              Granular Data Transmission Permissions
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowAiQuery}
                  onChange={(e) => setAllowAiQuery(e.target.checked)}
                  className="mt-1 rounded border-slate-300 text-emerald-700 focus:ring-emerald-600"
                />
                <span>
                  <strong className="block text-slate-900 font-medium">Allow AI Search &amp; Q&amp;A</strong>
                  <span className="text-xs text-slate-600">Permit authorized chunks to be queried</span>
                </span>
              </label>

              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={redactPiiOnTransmit}
                  onChange={(e) => setRedactPiiOnTransmit(e.target.checked)}
                  className="mt-1 rounded border-slate-300 text-emerald-700 focus:ring-emerald-600"
                />
                <span>
                  <strong className="block text-slate-900 font-medium">Redact PII Before Transmit</strong>
                  <span className="text-xs text-slate-600">Mask emails, phones, SSNs, and cards</span>
                </span>
              </label>

              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowDownload}
                  onChange={(e) => setAllowDownload(e.target.checked)}
                  className="mt-1 rounded border-slate-300 text-emerald-700 focus:ring-emerald-600"
                />
                <span>
                  <strong className="block text-slate-900 font-medium">Allow Text Export</strong>
                  <span className="text-xs text-slate-600">Permit readers to export extracted text</span>
                </span>
              </label>

              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowExternalShare}
                  onChange={(e) => setAllowExternalShare(e.target.checked)}
                  className="mt-1 rounded border-slate-300 text-emerald-700 focus:ring-emerald-600"
                />
                <span>
                  <strong className="block text-slate-900 font-medium">Allow External Share</strong>
                  <span className="text-xs text-slate-600">Permit outbound webhook forwarding</span>
                </span>
              </label>
            </div>
          </div>

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

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !selectedFile}
              className="px-5 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              {submitting ? 'Indexing Document...' : 'Ingest & Enforce Policies'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
