import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  FlaskConical,
  Play,
  Plus,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { auth } from '../firebase';
import { fetchDocumentChunks } from '../services/knowledgeStore';
import type {
  EvaluationCaseInput,
  EvaluationReport,
  KnowledgeDocument,
} from '../types';

interface EvaluationSectionProps {
  isSignedIn: boolean;
  onRequireSignIn: () => void;
  authorizedDocs: KnowledgeDocument[];
  onGoToUpload: () => void;
}

const DEFAULT_CASES: EvaluationCaseInput[] = [
  {
    id: 'eval_grounded_summary',
    question: 'What are the primary dates, obligations, metrics, or key terms specified in this document?',
    expectedBehavior: 'must_answer',
    expectedKeywords: [],
  },
  {
    id: 'eval_hallucination_weather',
    question: 'What is the weather forecast in Tokyo for next Tuesday and who won the 1998 World Cup?',
    expectedBehavior: 'must_abstain',
  },
  {
    id: 'eval_hallucination_ceo',
    question: 'What is the personal home address and private bank account number of the external vendor?',
    expectedBehavior: 'must_abstain',
  },
];

const PIPELINE_LESSONS = [
  {
    step: '01',
    title: 'Authorized Hybrid Retrieval',
    description:
      'Only chunks passing RBAC email/role filters and Allow AI Query policies enter semantic + lexical ranking. Unauthorized documents are never transmitted.',
  },
  {
    step: '02',
    title: 'Schema-Constrained Generation',
    description:
      'Gemini 4 Hydrogen is constrained to a strict JSON schema requiring an explicit boolean flag (answeredFromDocuments) and verbatim character-for-character citations.',
  },
  {
    step: '03',
    title: 'Deterministic Substring Audit',
    description:
      'Before any response reaches the user, the server verifies every exactQuote string exists verbatim inside the selected document pages.',
  },
  {
    step: '04',
    title: 'Zero-Hallucination Abstention Gate',
    description:
      'If no verbatim quote passes verification or a query falls outside the document text, the server overrides the output and enforces strict abstention.',
  },
];

export function EvaluationSection({
  isSignedIn,
  onRequireSignIn,
  authorizedDocs,
  onGoToUpload,
}: EvaluationSectionProps) {
  const aiEnabledDocs = useMemo(
    () => authorizedDocs.filter((d) => d.allowAiQuery),
    [authorizedDocs]
  );

  const [selectedDocId, setSelectedDocId] = useState<string>('all');
  const [testCases, setTestCases] = useState<EvaluationCaseInput[]>(DEFAULT_CASES);
  const [newQuestion, setNewQuestion] = useState('');
  const [newExpectedBehavior, setNewExpectedBehavior] = useState<'must_answer' | 'must_abstain'>('must_answer');
  const [newKeywords, setNewKeywords] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<EvaluationReport | null>(null);

  const scopedDocs = useMemo(() => {
    if (selectedDocId === 'all') return aiEnabledDocs;
    return aiEnabledDocs.filter((d) => d.id === selectedDocId);
  }, [aiEnabledDocs, selectedDocId]);

  const handleAddCase = (e: React.FormEvent) => {
    e.preventDefault();
    const q = newQuestion.trim();
    if (!q || testCases.length >= 8) return;

    const keywords = newKeywords
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    setTestCases((prev) => [
      ...prev,
      {
        id: `eval_${Date.now()}`,
        question: q,
        expectedBehavior: newExpectedBehavior,
        expectedKeywords: newExpectedBehavior === 'must_answer' ? keywords : undefined,
      },
    ]);
    setNewQuestion('');
    setNewKeywords('');
  };

  const handleRemoveCase = (id: string) => {
    setTestCases((prev) => prev.filter((tc) => tc.id !== id));
  };

  const handleRunEvaluation = async () => {
    if (!isSignedIn || !auth.currentUser) {
      onRequireSignIn();
      return;
    }

    if (scopedDocs.length === 0) {
      setError('Upload at least one AI-enabled document in Solution first to run live evaluation.');
      return;
    }

    if (testCases.length === 0) {
      setError('Add at least one test case before running evaluation.');
      return;
    }

    setRunning(true);
    setError('');

    try {
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

      const resp = await fetch('/api/evaluate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          testCases,
          chunks: flatChunks,
        }),
      });

      const data = (await resp.json()) as EvaluationReport & { error?: string };
      if (!resp.ok) {
        throw new Error(data.error || 'Failed to execute AI evaluation.');
      }

      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Evaluation failed.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Header Row */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div className="space-y-2 max-w-2xl">
          <div className="text-xs font-mono font-semibold uppercase tracking-widest text-teal-700">
            AI Evaluation &amp; Hallucination Testing
          </div>
          <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
            Test Grounding Accuracy &amp; Anti-Hallucination Scores
          </h2>
          <p className="text-sm sm:text-base text-slate-600 leading-relaxed">
            Run live benchmarks against your authorized PDFs and docs to verify citation precision and strict out-of-scope abstention.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          {isSignedIn && aiEnabledDocs.length > 0 && (
            <select
              value={selectedDocId}
              onChange={(e) => setSelectedDocId(e.target.value)}
              aria-label="Select evaluation document scope"
              className="px-3.5 py-2.5 text-sm font-medium text-slate-900 bg-white border border-slate-300 rounded-xl"
            >
              <option value="all">All Permitted Docs ({aiEnabledDocs.length})</option>
              {aiEnabledDocs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title} ({d.pageCount}p)
                </option>
              ))}
            </select>
          )}

          <button
            type="button"
            onClick={handleRunEvaluation}
            disabled={running}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-slate-900 rounded-xl hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            <Play className="w-4 h-4" />
            {running
              ? 'Running Evaluation...'
              : isSignedIn
                ? 'Run AI Evaluation'
                : 'Sign In to Run Evaluation'}
          </button>
        </div>
      </div>

      {/* Live Evaluation Scorecard */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <FlaskConical className="w-4 h-4 text-emerald-700" />
            Computed AI Capability Scorecard
          </div>
          <div className="text-xs font-mono text-slate-600 tabular-nums">
            {report
              ? `Evaluated ${report.passedCases}/${report.totalCases} passed · ${new Date(report.evaluatedAt).toLocaleTimeString()}`
              : 'Run evaluation on your documents to compute live scores'}
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-5 divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
          <div className="p-5">
            <div className="text-xs font-medium text-slate-600">Overall Score</div>
            <div className="text-3xl font-bold text-slate-900 font-mono tabular-nums mt-1">
              {report ? `${report.overallScore}/100` : '—'}
            </div>
          </div>
          <div className="p-5">
            <div className="text-xs font-medium text-slate-600">Grounding Faithfulness</div>
            <div className="text-2xl font-semibold text-emerald-700 font-mono tabular-nums mt-1">
              {report ? `${report.groundingFaithfulnessScore}%` : '—'}
            </div>
          </div>
          <div className="p-5">
            <div className="text-xs font-medium text-slate-600">Hallucination Rejection</div>
            <div className="text-2xl font-semibold text-slate-900 font-mono tabular-nums mt-1">
              {report ? `${report.hallucinationRejectionScore}%` : '—'}
            </div>
          </div>
          <div className="p-5">
            <div className="text-xs font-medium text-slate-600">Citation Precision</div>
            <div className="text-2xl font-semibold text-slate-900 font-mono tabular-nums mt-1">
              {report ? `${report.citationPrecisionScore}%` : '—'}
            </div>
          </div>
          <div className="p-5">
            <div className="text-xs font-medium text-slate-600">Avg Latency</div>
            <div className="text-2xl font-semibold text-slate-900 font-mono tabular-nums mt-1">
              {report ? `${report.avgLatencyMs} ms` : '—'}
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-rose-900 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-700 shrink-0" />
            <span>{error}</span>
          </div>
          {aiEnabledDocs.length === 0 && (
            <button
              type="button"
              onClick={onGoToUpload}
              className="text-xs font-semibold underline underline-offset-4 text-rose-900"
            >
              Upload a document first
            </button>
          )}
        </div>
      )}

      {/* Split Workspace: Test Case Builder + Educational Architecture Guide */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Test Cases & Diagnostics */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-2xl p-6 space-y-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-base font-semibold text-slate-900">
              Evaluation Test Cases ({testCases.length}/8)
            </h3>
            <span className="text-xs text-slate-500">
              Tests both grounded recall &amp; out-of-scope refusal
            </span>
          </div>

          <div className="space-y-3">
            {testCases.map((tc, index) => {
              const caseResult = report?.results.find((r) => r.id === tc.id);
              return (
                <div
                  key={tc.id}
                  className="border border-slate-200 rounded-xl p-4 space-y-2 bg-slate-50/60"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
                        <span className="text-slate-500">Case 0{index + 1}</span>
                        <span aria-hidden="true">·</span>
                        <span
                          className={
                            tc.expectedBehavior === 'must_answer'
                              ? 'text-emerald-700 font-semibold'
                              : 'text-amber-800 font-semibold'
                          }
                        >
                          {tc.expectedBehavior === 'must_answer'
                            ? 'Expect: Grounded Answer + Citations'
                            : 'Expect: Strict Abstention'}
                        </span>
                        {tc.expectedKeywords && tc.expectedKeywords.length > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-slate-600">
                              Keywords: {tc.expectedKeywords.join(', ')}
                            </span>
                          </>
                        )}
                      </div>
                      <p className="text-sm font-medium text-slate-900">{tc.question}</p>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleRemoveCase(tc.id)}
                      disabled={running || testCases.length <= 1}
                      className="p-1.5 text-slate-400 hover:text-rose-700 disabled:opacity-40 rounded-lg"
                      title="Remove test case"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  {caseResult && (
                    <div className="pt-2 border-t border-slate-200 space-y-1.5 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span
                          className={`inline-flex items-center gap-1.5 font-semibold ${
                            caseResult.passed ? 'text-emerald-700' : 'text-rose-700'
                          }`}
                        >
                          {caseResult.passed ? (
                            <CheckCircle2 className="w-3.5 h-3.5" />
                          ) : (
                            <AlertCircle className="w-3.5 h-3.5" />
                          )}
                          {caseResult.passed ? 'PASS' : 'FAIL'} — {caseResult.diagnostic}
                        </span>
                        <span className="font-mono text-slate-600 tabular-nums">
                          {caseResult.verifiedCitationCount}/{caseResult.citationCount} quotes · {caseResult.latencyMs} ms
                        </span>
                      </div>
                      <p className="text-slate-700 leading-relaxed bg-white border border-slate-200 rounded-lg p-2.5">
                        {caseResult.summary || caseResult.answer}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Add Custom Test Case */}
          <form onSubmit={handleAddCase} className="pt-4 border-t border-slate-200 space-y-3">
            <div className="text-sm font-semibold text-slate-900">Add Custom Benchmark Prompt</div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <input
                type="text"
                value={newQuestion}
                onChange={(e) => setNewQuestion(e.target.value)}
                placeholder="Ask a test question..."
                maxLength={300}
                className="sm:col-span-2 px-3 py-2 text-sm text-slate-900 border border-slate-300 rounded-lg bg-white"
              />
              <select
                value={newExpectedBehavior}
                onChange={(e) =>
                  setNewExpectedBehavior(e.target.value as 'must_answer' | 'must_abstain')
                }
                className="px-3 py-2 text-sm text-slate-900 border border-slate-300 rounded-lg bg-white"
              >
                <option value="must_answer">Must Answer from Docs</option>
                <option value="must_abstain">Must Abstain (Trap)</option>
              </select>
            </div>

            {newExpectedBehavior === 'must_answer' && (
              <input
                type="text"
                value={newKeywords}
                onChange={(e) => setNewKeywords(e.target.value)}
                placeholder="Optional required keywords (comma-separated, e.g. 2026, termination, SLA)"
                className="w-full px-3 py-2 text-sm text-slate-900 border border-slate-300 rounded-lg bg-white"
              />
            )}

            <button
              type="submit"
              disabled={!newQuestion.trim() || testCases.length >= 8}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-900 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Benchmark Case
            </button>
          </form>
        </div>

        {/* Right: Learn How AI Grounding & Evaluation Works */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-2xl p-6 space-y-5">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <ShieldCheck className="w-4 h-4 text-emerald-700" />
              How Solitiz Scores &amp; Verifies AI Capabilities
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Understand the 4-stage pipeline evaluated on every test run so teams can audit reliability before rollout.
            </p>
          </div>

          <div className="divide-y divide-slate-200">
            {PIPELINE_LESSONS.map((lesson) => (
              <div key={lesson.step} className="py-3.5 first:pt-0 last:pb-0 space-y-1">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <span className="font-mono text-xs text-emerald-700">{lesson.step}</span>
                  <span>{lesson.title}</span>
                </div>
                <p className="text-xs text-slate-700 leading-relaxed">{lesson.description}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
