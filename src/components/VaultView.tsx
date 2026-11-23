import React, { useMemo, useState } from 'react';
import { FileText, Lock, Search, ShieldCheck, Upload } from 'lucide-react';
import type { KnowledgeDocument } from '../types';

interface VaultViewProps {
  documents: KnowledgeDocument[];
  onInspectDocument: (doc: KnowledgeDocument) => void;
  onOpenUpload: () => void;
}

export function VaultView({ documents, onInspectDocument, onOpenUpload }: VaultViewProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [visibilityFilter, setVisibilityFilter] = useState<'all' | 'private' | 'role_restricted' | 'organization'>('all');

  const filteredDocs = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return documents.filter((d) => {
      if (visibilityFilter !== 'all' && d.visibility !== visibilityFilter) {
        return false;
      }
      if (!q) return true;
      return (
        d.title.toLowerCase().includes(q) ||
        d.fileName.toLowerCase().includes(q) ||
        d.department.toLowerCase().includes(q)
      );
    });
  }, [documents, searchTerm, visibilityFilter]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            Authorized Document Vault
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Personal PDFs and synced enterprise records visible under your active role permissions.
          </p>
        </div>

        <button
          type="button"
          onClick={onOpenUpload}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap shrink-0"
        >
          <Upload className="w-4 h-4" />
          Upload PDF / Document
        </button>
      </div>

      {/* Filter & Search Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative w-full sm:max-w-sm">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Filter by title, filename, or department..."
            className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-700"
          />
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start">
          {(
            [
              { id: 'all', label: 'All' },
              { id: 'private', label: 'Private' },
              { id: 'role_restricted', label: 'Role-Restricted' },
              { id: 'organization', label: 'Organization' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setVisibilityFilter(tab.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                visibilityFilter === tab.id
                  ? 'bg-white text-slate-900'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Document Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {filteredDocs.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <FileText className="w-7 h-7 text-slate-400 mx-auto" />
            <h3 className="text-sm font-semibold text-slate-900">
              {documents.length === 0 ? 'No Documents Uploaded Yet' : 'No Matching Documents'}
            </h3>
            <p className="text-xs text-slate-500 max-w-md mx-auto">
              {documents.length === 0
                ? 'Upload a personal PDF, Markdown file, or contract to inspect extracted pages and ask strictly grounded questions.'
                : 'Try adjusting your search query or access scope filter.'}
            </p>
            {documents.length === 0 && (
              <button
                type="button"
                onClick={onOpenUpload}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                <Upload className="w-3.5 h-3.5" />
                Upload First PDF
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                  <th className="py-2.5 px-4">Document</th>
                  <th className="py-2.5 px-4">Department</th>
                  <th className="py-2.5 px-4">Access Scope</th>
                  <th className="py-2.5 px-4">Transmission Policy</th>
                  <th className="py-2.5 px-4 text-right">Pages / Chunks</th>
                  <th className="py-2.5 px-4 text-right">Size</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {filteredDocs.map((docItem) => (
                  <tr
                    key={docItem.id}
                    onClick={() => onInspectDocument(docItem)}
                    className="hover:bg-slate-50 cursor-pointer transition-colors"
                  >
                    <td className="py-3 px-4">
                      <div className="font-medium text-slate-900">{docItem.title}</div>
                      <div className="text-slate-400 mt-0.5 flex items-center gap-1.5">
                        <span className="font-mono">{docItem.fileName}</span>
                        <span aria-hidden="true">·</span>
                        <span className="capitalize">{docItem.sourceType.replace('_', ' ')}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-slate-700">{docItem.department}</td>
                    <td className="py-3 px-4 text-slate-700">
                      <span className="capitalize font-medium text-slate-900">
                        {docItem.visibility.replace('_', ' ')}
                      </span>
                      {docItem.visibility === 'role_restricted' && docItem.allowedRoles.length > 0 && (
                        <div className="text-slate-400 mt-0.5">
                          {docItem.allowedRoles.join(', ')}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      {docItem.allowAiQuery ? (
                        <span className="inline-flex items-center gap-1.5 text-emerald-800">
                          <ShieldCheck className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
                          AI Enabled
                          {docItem.redactPiiOnTransmit ? ' · PII Redacted' : ''}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-amber-800">
                          <Lock className="w-3.5 h-3.5 text-amber-700 shrink-0" />
                          AI Query Blocked
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-slate-700 tabular-nums whitespace-nowrap">
                      {docItem.pageCount}p / {docItem.chunkCount}
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-slate-500 tabular-nums whitespace-nowrap">
                      {(docItem.fileSize / 1024).toFixed(1)} KB
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
