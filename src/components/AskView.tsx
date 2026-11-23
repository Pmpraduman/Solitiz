import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowUpRight,
  FileText,
  Lock,
  Search,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import { auth } from '../firebase';
import {
  fetchDocumentChunks,
  logAuditEvent,
  recordSearchAnalytic,
} from '../services/knowledgeStore';
import type {
  Citation,
  KnowledgeDocument,
  QaMessage,
  StructuredSection,
  UserRole,
} from '../types';

interface AskViewProps {
  isSignedIn: boolean;
  onRequireSignIn: () => void;
  signingIn?: boolean;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
  authorizedDocs: KnowledgeDocument[];
  userUid: string;
  userEmail: string;
  effectiveRole: UserRole;
  onOpenUpload: () => void;
  onInspectCitation: (doc: KnowledgeDocument, pageNumber: number, exactQuote: string) => void;
}

export function AskView({
  isSignedIn,
  onRequireSignIn,
  signingIn = false,
  searchInputRef,
  authorizedDocs,
  userUid,
  userEmail,
  effectiveRole,
  onOpenUpload,
  onInspectCitation,
}: AskViewProps) {
  const [selectedDocId, setSelectedDocId] = useState<string>('all');
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [messages, setMessages] = useState<QaMessage[]>([]);

  const aiEnabledDocs = useMemo(
    () => authorizedDocs.filter((d) => d.allowAiQuery),
    [authorizedDocs]
  );

  const policyBlockedDocs = useMemo(
    () => authorizedDocs.filter((d) => !d.allowAiQuery),
    [authorizedDocs]
  );

  const scopedDocs = useMemo(() => {
    if (selectedDocId === 'all') return aiEnabledDocs;
    return aiEnabledDocs.filter((d) => d.id === selectedDocId);
  }, [aiEnabledDocs, selectedDocId]);

  const handleAsk = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSignedIn || !auth.currentUser) {
      onRequireSignIn();
      return;
    }

    const trimmed = question.trim();
    if (!trimmed) return;

    setLoading(true);
    setError('');

    try {
      if (selectedDocId !== 'all') {
        const target = authorizedDocs.find((d) => d.id === selectedDocId);
        if (target && !target.allowAiQuery) {
          throw new Error(
            `"${target.title}" is restricted by transmission policy (Allow AI Query is disabled).`
          );
        }
      }

      const chunkBatches = await Promise.all(
        scopedDocs.map(async (docItem) => {
          const chunks = await fetchDocumentChunks(docItem.id);
          return chunks.map((ch) => ({
            docId: docItem.id,
            documentTitle: docItem.title,
            pageNumber: ch.pageNumber,
            sectionTitle: ch.sectionTitle,
            text: ch.text,
            redactPiiOnTransmit: docItem.redactPiiOnTransmit,
          }));
        })
      );

      const flatChunks = chunkBatches.flat();
      const idToken = await auth.currentUser.getIdToken(true);

      const resp = await fetch('/api/ask', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          question: trimmed,
          chunks: flatChunks,
        }),
      });

      const data = (await resp.json()) as {
        error?: string;
        answeredFromDocuments: boolean;
        summary?: string;
        sections?: StructuredSection[];
        answer: string;
        abstentionReason?: string;
        citations: Citation[];
        piiRedactedCount: number;
        chunksScanned: number;
        latencyMs?: number;
      };

      if (!resp.ok) {
        throw new Error(data.error || 'Failed to query documents.');
      }

      const scopeLabel =
        selectedDocId === 'all'
          ? `All permitted documents (${scopedDocs.length})`
          : scopedDocs[0]?.title || 'Selected Document';

      const msg: QaMessage = {
        id: `qa_${Date.now()}`,
        question: trimmed,
        answeredFromDocuments: data.answeredFromDocuments,
        summary: data.summary,
        sections: data.sections || [],
        answer: data.answer,
        abstentionReason: data.abstentionReason,
        citations: data.citations || [],
        piiRedactedCount: data.piiRedactedCount || 0,
        chunksScanned: data.chunksScanned || 0,
        latencyMs: data.latencyMs,
        scopeLabel,
        excludedCount: selectedDocId === 'all' ? policyBlockedDocs.length : 0,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };

      setMessages((prev) => [msg, ...prev]);
      setQuestion('');

      await Promise.all([
        logAuditEvent({
          actorUid: userUid,
          actorEmail: userEmail,
          actorRole: effectiveRole,
          action: data.answeredFromDocuments ? 'ai_query' : 'ai_abstain',
          targetId: selectedDocId,
          targetTitle: scopeLabel,
          details: `Query: "${trimmed.slice(0, 140)}" | Scanned ${data.chunksScanned} chunk(s) | Citations: ${data.citations?.length || 0} | PII Masked: ${data.piiRedactedCount || 0}.`,
          piiRedacted: (data.piiRedactedCount || 0) > 0,
        }),
        recordSearchAnalytic({
          rawQuery: trimmed,
          department: scopedDocs[0]?.department || effectiveRole,
          outcome: data.answeredFromDocuments ? 'answered' : 'knowledge_gap',
          citationCount: data.citations?.length || 0,
        }),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Query failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Central Enterprise Search Console */}
      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-4">
        <form onSubmit={handleAsk} className="space-y-4">
          <div className="flex flex-col lg:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="w-5 h-5 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2" />
              <input
                ref={searchInputRef}
                type="text"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                maxLength={1000}
                placeholder={
                  !isSignedIn
                    ? 'Sign in with Google Workspace to search across your enterprise documents...'
                    : authorizedDocs.length === 0
                      ? 'Upload a PDF or connect a tool first, then ask any question here...'
                      : 'Ask a plain-language question across all integrated documents...'
                }
                disabled={loading}
                className="w-full h-12 pl-12 pr-4 text-base text-slate-900 placeholder:text-slate-500 bg-white border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-600/25 focus:border-teal-700 disabled:bg-slate-100"
              />
            </div>

            {isSignedIn && (
              <select
                value={selectedDocId}
                onChange={(e) => setSelectedDocId(e.target.value)}
                aria-label="Select document scope"
                className="h-12 px-4 text-sm font-medium text-slate-900 bg-white border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-600/25 focus:border-teal-700 lg:w-64"
              >
                <option value="all">
                  All Permitted Docs ({aiEnabledDocs.length})
                </option>
                {authorizedDocs.map((d) => (
                  <option key={d.id} value={d.id} disabled={!d.allowAiQuery}>
                    {d.title} ({d.pageCount}p){!d.allowAiQuery ? ' — Blocked' : ''}
                  </option>
                ))}
              </select>
            )}

            {isSignedIn ? (
              <button
                type="submit"
                disabled={loading || !question.trim() || scopedDocs.length === 0}
                className="h-12 px-6 inline-flex items-center justify-center gap-2 text-sm font-semibold text-white bg-slate-900 rounded-xl hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                <Search className="w-4 h-4" />
                {loading ? 'Searching...' : 'Search'}
              </button>
            ) : (
              <button
                type="button"
                onClick={onRequireSignIn}
                disabled={signingIn}
                className="h-12 px-6 inline-flex items-center justify-center gap-2 text-sm font-semibold text-white bg-teal-700 rounded-xl hover:bg-teal-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                {signingIn ? 'Signing in...' : 'Sign in to Search'}
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600 pt-1">
            <div className="flex flex-wrap items-center gap-4">
              <span className="inline-flex items-center gap-1.5 font-medium text-slate-800">
                <ShieldCheck className="w-4 h-4 text-teal-700 shrink-0" />
                {isSignedIn ? (
                  <>
                    <span className="tabular-nums">{scopedDocs.length}</span> searchable document(s)
                  </>
                ) : (
                  'Zero-hallucination verification · RBAC & PII masking'
                )}
              </span>

              {isSignedIn && policyBlockedDocs.length > 0 && (
                <span className="inline-flex items-center gap-1.5 text-amber-800 font-medium">
                  <Lock className="w-4 h-4 shrink-0" />
                  <span className="tabular-nums">{policyBlockedDocs.length}</span> excluded by policy
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3 text-sm">
              {isSignedIn && scopedDocs.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => setQuestion('Summarize the key terms, obligations, dates, and figures in this document.')}
                    className="font-medium text-slate-700 hover:text-teal-700 underline underline-offset-4"
                  >
                    Key terms &amp; dates
                  </button>
                  <span className="text-slate-300" aria-hidden="true">·</span>
                  <button
                    type="button"
                    onClick={() => setQuestion('What is the weather in Tokyo tomorrow?')}
                    className="font-medium text-slate-700 hover:text-teal-700 underline underline-offset-4"
                  >
                    Test zero-hallucination guard
                  </button>
                  <span className="text-slate-300" aria-hidden="true">·</span>
                </>
              )}
              <button
                type="button"
                onClick={isSignedIn ? onOpenUpload : onRequireSignIn}
                className="inline-flex items-center gap-1.5 font-semibold text-teal-700 hover:text-teal-800 whitespace-nowrap"
              >
                <Upload className="w-3.5 h-3.5" />
                Upload PDF / Doc
              </button>
            </div>
          </div>
        </form>

        {error && (
          <div className="flex items-center gap-2.5 text-sm text-rose-900 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">
            <AlertCircle className="w-4 h-4 shrink-0 text-rose-700" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* Empty State or Structured LLM-Style Grounded Response Feed */}
      {isSignedIn && authorizedDocs.length === 0 && (
        <div className="bg-white border border-slate-200 rounded-2xl p-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <FileText className="w-6 h-6 text-slate-700 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-slate-900">
                Upload Your First Document to Start Searching
              </h2>
              <p className="text-sm text-slate-700 max-w-xl leading-relaxed">
                Upload a PDF directly here or integrate Confluence, Notion, or Slack inside the Solution section below.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onOpenUpload}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-slate-900 rounded-xl hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            <Upload className="w-4 h-4" />
            Upload Document
          </button>
        </div>
      )}

      {messages.length > 0 && (
        <div className="space-y-4">
          {messages.map((item) => (
            <article
              key={item.id}
              className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-7 space-y-5"
            >
              {/* Query & Audit Metadata */}
              <div className="flex flex-wrap items-center justify-between gap-2 pb-3.5 border-b border-slate-200">
                <h3 className="text-lg font-semibold text-slate-900">{item.question}</h3>
                <div className="text-xs font-mono text-slate-600 tabular-nums">
                  {item.timestamp}
                  {typeof item.latencyMs === 'number' ? ` · ${item.latencyMs} ms` : ''}
                  {` · ${item.chunksScanned} chunks`}
                  {item.piiRedactedCount > 0 ? ` · ${item.piiRedactedCount} PII masked` : ''}
                </div>
              </div>

              {/* Grounding Status Line */}
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {item.answeredFromDocuments ? (
                  <span className="inline-flex items-center gap-1.5 text-emerald-800">
                    <ShieldCheck className="w-4 h-4 text-emerald-700" />
                    Verified from Authorized Documents
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-amber-800">
                    <AlertCircle className="w-4 h-4 text-amber-700" />
                    Not Found in Documents — Abstention Enforced
                  </span>
                )}
                <span className="text-slate-300" aria-hidden="true">·</span>
                <span className="text-slate-600 font-normal">Scope: {item.scopeLabel}</span>
              </div>

              {/* Well-Structured LLM-Style Response */}
              {item.answeredFromDocuments && (item.summary || (item.sections && item.sections.length > 0)) ? (
                <div className="space-y-4">
                  {item.summary && (
                    <div className="bg-slate-50 border border-slate-200 rounded-xl px-5 py-4">
                      <div className="text-xs font-mono uppercase tracking-wider text-slate-500 mb-1">
                        Executive Summary
                      </div>
                      <p className="text-base text-slate-900 leading-relaxed font-medium">
                        {item.summary}
                      </p>
                    </div>
                  )}

                  {item.sections && item.sections.length > 0 ? (
                    <div className="space-y-4">
                      {item.sections.map((sec, sIdx) => (
                        <div key={`${item.id}_sec_${sIdx}`} className="space-y-2">
                          <h4 className="text-sm font-semibold text-slate-900">
                            {sec.heading}
                          </h4>
                          <ul className="space-y-1.5 pl-5 list-disc text-sm sm:text-base text-slate-800 leading-relaxed marker:text-emerald-700">
                            {sec.points.map((pt, pIdx) => (
                              <li key={`${item.id}_pt_${sIdx}_${pIdx}`}>{pt}</li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-base text-slate-900 leading-relaxed whitespace-pre-wrap">
                      {item.answer}
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-base text-slate-900 leading-relaxed whitespace-pre-wrap">
                  {item.answer}
                </div>
              )}

              {!item.answeredFromDocuments && item.abstentionReason && (
                <p className="text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5">
                  {item.abstentionReason}
                </p>
              )}

              {/* Verbatim Source Citations */}
              {item.citations.length > 0 && (
                <div className="pt-4 border-t border-slate-200 space-y-3">
                  <div className="text-sm font-semibold text-slate-900">
                    Verified Evidence Sources ({item.citations.length})
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {item.citations.map((cit, idx) => {
                      const docObj = authorizedDocs.find((d) => d.id === cit.docId);
                      return (
                        <div
                          key={`${item.id}_cit_${idx}`}
                          className="border border-slate-200 rounded-xl p-4 bg-slate-50 flex flex-col justify-between gap-3"
                        >
                          <div className="space-y-1.5 min-w-0">
                            <div className="text-sm font-semibold text-slate-900">
                              {cit.documentTitle}{' '}
                              <span className="text-slate-600 font-mono font-normal tabular-nums">
                                · Page {cit.pageNumber}
                              </span>
                            </div>
                            <p className="text-sm text-slate-800 leading-relaxed">
                              &ldquo;{cit.exactQuote}&rdquo;
                            </p>
                          </div>

                          {docObj && (
                            <div className="flex justify-end">
                              <button
                                type="button"
                                onClick={() =>
                                  onInspectCitation(docObj, cit.pageNumber, cit.exactQuote)
                                }
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-900 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 whitespace-nowrap shrink-0"
                              >
                                Inspect Page
                                <ArrowUpRight className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
