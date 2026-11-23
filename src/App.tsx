import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Database,
  FlaskConical,
  FolderLock,
  Layers,
  Link2,
  Mail,
  MapPin,
  Search,
  Shield,
  ShieldCheck,
  Upload,
  X,
  XCircle,
} from 'lucide-react';
import { onAuthStateChanged, signInWithPopup, type User } from 'firebase/auth';
import { auth, BOOTSTRAP_ADMIN_EMAIL, googleProvider } from './firebase';
import {
  canEffectiveRoleAccessDoc,
  ensureUserProfile,
  subscribeAuditLogs,
  subscribeAuthorizedDocuments,
  subscribeConnectors,
  subscribeRoleGrants,
  subscribeSearchAnalytics,
  subscribeUserProfiles,
} from './services/knowledgeStore';
import type {
  AuditLogEntry,
  EnterpriseConnector,
  KnowledgeDocument,
  RoleGrant,
  SearchAnalyticEvent,
  UserProfile,
  UserRole,
} from './types';
import { AskView } from './components/AskView';
import { InlineUploadPanel } from './components/InlineUploadPanel';
import { VaultView } from './components/VaultView';
import { ConnectorsView } from './components/ConnectorsView';
import { AccessControlView } from './components/AccessControlView';
import { SearchTrendsView } from './components/SearchTrendsView';
import { EvaluationSection } from './components/EvaluationSection';
import { UploadModal } from './components/UploadModal';
import { DocumentEvidenceDrawer } from './components/DocumentEvidenceDrawer';

type ActiveWorkspaceModule =
  | null
  | 'search'
  | 'upload'
  | 'vault'
  | 'rbac'
  | 'connectors'
  | 'evaluation';

type ArchitectureTabId = 'prep' | 'manage' | 'secure' | 'retrieve';

const SOLUTION_POPUP_ITEMS: Array<{
  id: 'search' | 'upload' | 'rbac' | 'connectors';
  title: string;
  subtitle: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  {
    id: 'search',
    title: 'Enterprise AI Search',
    subtitle: 'Central Search Bar',
    description:
      'Search across all authorized PDFs and synced tools in plain English with structured answers and exact page citations.',
    icon: Search,
  },
  {
    id: 'upload',
    title: 'Document Upload',
    subtitle: 'PDF, Markdown, CSV & JSON',
    description:
      'Upload enterprise documents, index verbatim page chunks, and configure transmission permissions.',
    icon: Upload,
  },
  {
    id: 'rbac',
    title: 'RBAC',
    subtitle: 'Role-Based Access Control',
    description:
      'Manage user roles, document-level visibility rules, PII redaction policies, and audit trails.',
    icon: Shield,
  },
  {
    id: 'connectors',
    title: 'Tool Connectors',
    subtitle: 'External Tool Integrations',
    description:
      'Connect Confluence, Notion, Slack digests, and HTTPS REST knowledge feeds under policy controls.',
    icon: Link2,
  },
];

const MEMORY_CHALLENGES = [
  {
    title: 'Stale Document Silos',
    body: 'Duplicate files across teams create conflicting search answers.',
  },
  {
    title: 'Manual PII Exposure',
    body: 'Unmasked emails and IDs risk compliance during AI transmission.',
  },
  {
    title: 'Fragile Data Pipelines',
    body: 'Broken syncs hide critical updates until queries fail.',
  },
  {
    title: 'Inconsistent Retrieval',
    body: 'Uncalibrated search misses exact clauses in long contracts.',
  },
  {
    title: 'Unsupported Answers',
    body: 'Models fabricate responses when page citations are missing.',
  },
];

const ARCHITECTURE_TABS: Array<{
  id: ArchitectureTabId;
  label: string;
  heading: string;
  description: string;
  nextLabel: string;
  nextTab: ArchitectureTabId;
  imageSrc: string;
  imageAlt: string;
}> = [
  {
    id: 'prep',
    label: 'Advanced Data Prep',
    heading: 'Clean Page-by-Page Ingestion',
    description:
      'Convert PDFs, scans, Markdown, and spreadsheets into clean indexed passages automatically without manual formatting.',
    nextLabel: 'Management Made Simple',
    nextTab: 'manage',
    imageSrc: '/src/assets/images/solitiz_data_prep_1795408977624.jpg',
    imageAlt: 'Isometric glass data preparation flow indexing files into knowledge chunks',
  },
  {
    id: 'manage',
    label: 'Management Made Simple',
    heading: 'Unified Tool & Vault Sync',
    description:
      'Bring Confluence, Notion, Slack, and uploaded documents into one permission-aware enterprise knowledge hub.',
    nextLabel: 'Secure Architecture',
    nextTab: 'secure',
    imageSrc: '/src/assets/images/solitiz_ingestion_layers_1795408977481.jpg',
    imageAlt: 'Layered enterprise knowledge pipelines connecting external sources cleanly',
  },
  {
    id: 'secure',
    label: 'Secure Architecture',
    heading: 'Granular RBAC & PII Protection',
    description:
      'Control access by role or email, mask sensitive PII automatically on transmit, and track every query.',
    nextLabel: 'Dynamic Retrieval',
    nextTab: 'retrieve',
    imageSrc: '/src/assets/images/solitiz_data_prep_1795408977624.jpg',
    imageAlt: 'Security boundary filtering authorized knowledge chunks before transmission',
  },
  {
    id: 'retrieve',
    label: 'Dynamic Retrieval',
    heading: 'Zero-Hallucination Grounding',
    description:
      'Every answer is verified verbatim against source pages, or strictly withheld when evidence is not present.',
    nextLabel: 'Advanced Data Prep',
    nextTab: 'prep',
    imageSrc: '/src/assets/images/solitiz_ingestion_layers_1795408977481.jpg',
    imageAlt: 'Real-time verified retrieval delivering structured answers with page citations',
  },
];

const PRICING_TIERS = [
  {
    audience: 'For Early-Stage Teams',
    name: 'Core Workspace',
    price: '$0',
    cadence: '/ month',
    summary: 'Personal PDF search and role-isolated knowledge access.',
    specs: [
      'Up to 25 PDF & Markdown documents',
      '5 verified workspace seats',
      '2 external tool connectors',
      '100% verbatim citation checks',
    ],
    ctaLabel: 'Explore Solution',
    highlighted: false,
  },
  {
    audience: 'For Scaling Operations',
    name: 'Growth Enterprise',
    price: '$29',
    cadence: '/ seat / month',
    summary: 'Departmental RBAC, automatic PII masking, and evaluation labs.',
    specs: [
      'Up to 2,500 indexed documents',
      '6 role tiers + email policies',
      'Unlimited Confluence, Notion & REST',
      'Live hallucination evaluation suite',
    ],
    ctaLabel: 'Start with Solitiz',
    highlighted: true,
  },
  {
    audience: 'For Regulated Enterprises',
    name: 'Dedicated Governance',
    price: 'Custom',
    cadence: 'annual contract',
    summary: 'Cloud isolation, export locks, and compliance audit trails.',
    specs: [
      'Unlimited knowledge repositories',
      'Transmission & export lock controls',
      '365-day immutable audit trails',
      'Dedicated onboarding SLA under 4h',
    ],
    ctaLabel: 'Request Walkthrough',
    highlighted: false,
  },
];

export default function App() {
  const [authReady, setAuthReady] = useState(false);
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [authError, setAuthError] = useState('');
  const [signingIn, setSigningIn] = useState(false);

  // Strict progressive disclosure states:
  // activeModule === null -> pure clean Home Page
  // solutionPopupOpen === true -> shows the 4-item Solution Pop-Up
  const [activeModule, setActiveModule] = useState<ActiveWorkspaceModule>(null);
  const [solutionPopupOpen, setSolutionPopupOpen] = useState(false);

  const [showTrendsDrawer, setShowTrendsDrawer] = useState(false);
  const [archTab, setArchTab] = useState<ArchitectureTabId>('prep');
  const [comparisonMode, setComparisonMode] = useState<'without' | 'with'>('with');

  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [roleGrants, setRoleGrants] = useState<RoleGrant[]>([]);
  const [userProfiles, setUserProfiles] = useState<UserProfile[]>([]);
  const [connectors, setConnectors] = useState<EnterpriseConnector[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [searchEvents, setSearchEvents] = useState<SearchAnalyticEvent[]>([]);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [inspectedDoc, setInspectedDoc] = useState<KnowledgeDocument | null>(null);
  const [highlightPage, setHighlightPage] = useState<number | undefined>(undefined);
  const [highlightQuote, setHighlightQuote] = useState<string | undefined>(undefined);
  const [toastMessage, setToastMessage] = useState('');
  const [imageErrorMap, setImageErrorMap] = useState<Record<string, boolean>>({});
  const [footerInfoTopic, setFooterInfoTopic] = useState<
    null | 'Blog' | 'Careers' | 'Terms of Service' | 'Privacy Policy' | 'Cookie Policy' | 'Data Deletion'
  >(null);

  // Lead / Onboarding form
  const [leadFirst, setLeadFirst] = useState('');
  const [leadLast, setLeadLast] = useState('');
  const [leadCompany, setLeadCompany] = useState('');
  const [leadEmail, setLeadEmail] = useState('');
  const [leadError, setLeadError] = useState('');
  const [leadSubmitted, setLeadSubmitted] = useState(false);

  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user);
      if (user) {
        try {
          const profile = await ensureUserProfile(user);
          setUserProfile(profile);
        } catch (err) {
          setAuthError(err instanceof Error ? err.message : 'Failed to load profile.');
        }
      } else {
        setUserProfile(null);
        setDocuments([]);
        setRoleGrants([]);
        setUserProfiles([]);
        setConnectors([]);
        setAuditLogs([]);
        setSearchEvents([]);
      }
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  const isTrueAdmin = useMemo(() => {
    if (!firebaseUser) return false;
    return (
      (firebaseUser.email === BOOTSTRAP_ADMIN_EMAIL && firebaseUser.emailVerified) ||
      userProfile?.role === 'admin'
    );
  }, [firebaseUser, userProfile]);

  const effectiveRole: UserRole = useMemo(() => {
    if (isTrueAdmin) return 'admin';
    const matchingGrant = roleGrants.find(
      (g) => g.email.toLowerCase() === (firebaseUser?.email || '').toLowerCase()
    );
    return matchingGrant?.role || userProfile?.role || 'viewer';
  }, [isTrueAdmin, roleGrants, firebaseUser, userProfile]);

  useEffect(() => {
    if (!firebaseUser || !firebaseUser.email) return;

    const unsubDocs = subscribeAuthorizedDocuments(
      isTrueAdmin,
      firebaseUser.uid,
      firebaseUser.email,
      setDocuments
    );
    const unsubGrants = subscribeRoleGrants(isTrueAdmin, firebaseUser.email, setRoleGrants);
    const unsubProfiles = subscribeUserProfiles(isTrueAdmin, firebaseUser.uid, setUserProfiles);
    const unsubConnectors = subscribeConnectors(isTrueAdmin, firebaseUser.uid, setConnectors);
    const unsubLogs = subscribeAuditLogs(isTrueAdmin, firebaseUser.uid, setAuditLogs);
    const unsubTrends = subscribeSearchAnalytics(setSearchEvents);

    return () => {
      unsubDocs();
      unsubGrants();
      unsubProfiles();
      unsubConnectors();
      unsubLogs();
      unsubTrends();
    };
  }, [firebaseUser, isTrueAdmin]);

  const visibleDocuments = useMemo(() => {
    if (!firebaseUser || !firebaseUser.email) return [];
    return documents.filter((d) =>
      canEffectiveRoleAccessDoc(d, effectiveRole, firebaseUser.uid, firebaseUser.email!)
    );
  }, [documents, effectiveRole, firebaseUser]);

  const handleSignIn = async () => {
    setSigningIn(true);
    setAuthError('');
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Sign-in was cancelled or failed.');
    } finally {
      setSigningIn(false);
    }
  };

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(''), 4000);
  };

  const goHome = (scrollToId?: string) => {
    setSolutionPopupOpen(false);
    setActiveModule(null);
    setTimeout(() => {
      if (scrollToId) {
        const el = document.getElementById(scrollToId);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }, 30);
  };

  const openSolutionPopup = () => {
    setSolutionPopupOpen(true);
  };

  const selectSolutionItem = (module: ActiveWorkspaceModule) => {
    setSolutionPopupOpen(false);
    setActiveModule(module);
    setTimeout(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (module === 'search') {
        setTimeout(() => searchInputRef.current?.focus(), 200);
      }
    }, 30);
  };

  const openEvaluationView = () => {
    setSolutionPopupOpen(false);
    setActiveModule('evaluation');
    setTimeout(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 30);
  };

  const handleLeadSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setLeadError('');
    if (!leadFirst.trim() || !leadLast.trim() || !leadCompany.trim()) {
      setLeadError('Please complete your name and company.');
      return;
    }
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(leadEmail.trim())) {
      setLeadError('Please enter a valid business email.');
      return;
    }
    setLeadSubmitted(true);
  };

  if (!authReady) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="text-sm text-slate-600">Loading Solitiz...</div>
      </div>
    );
  }

  const isSignedIn = Boolean(firebaseUser);
  const activeUid = firebaseUser?.uid || '';
  const activeEmail = firebaseUser?.email || '';
  const currentArch = ARCHITECTURE_TABS.find((t) => t.id === archTab) || ARCHITECTURE_TABS[0];

  const activeModuleTitle =
    activeModule === 'search'
      ? 'Enterprise AI Search'
      : activeModule === 'upload'
        ? 'Document Upload'
        : activeModule === 'vault'
          ? 'Document Vault'
          : activeModule === 'rbac'
            ? 'Role-Based Access Control (RBAC)'
            : activeModule === 'connectors'
              ? 'Tool Connectors'
              : activeModule === 'evaluation'
                ? 'AI Evaluation & Hallucination Testing'
                : '';

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* Top 3-Zone Header: SOLITIZ | Home, Product, Solution, Evaluation, Price, About | Primary CTA */}
      <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-6">
          <button
            type="button"
            onClick={() => goHome()}
            className="text-lg font-bold tracking-[0.2em] uppercase text-slate-900 whitespace-nowrap shrink-0"
          >
            SOLITIZ
          </button>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
            <button
              type="button"
              onClick={() => goHome()}
              className={`transition-colors whitespace-nowrap shrink-0 ${
                activeModule === null ? 'text-slate-900 font-semibold' : 'hover:text-slate-900'
              }`}
            >
              Home
            </button>
            <button
              type="button"
              onClick={() => goHome('product')}
              className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
            >
              Product
            </button>
            <button
              type="button"
              onClick={openSolutionPopup}
              className={`transition-colors whitespace-nowrap shrink-0 ${
                solutionPopupOpen ||
                (activeModule !== null && activeModule !== 'evaluation')
                  ? 'text-teal-700 font-semibold'
                  : 'hover:text-slate-900'
              }`}
            >
              Solution
            </button>
            <button
              type="button"
              onClick={openEvaluationView}
              className={`transition-colors whitespace-nowrap shrink-0 ${
                activeModule === 'evaluation'
                  ? 'text-teal-700 font-semibold'
                  : 'hover:text-slate-900'
              }`}
            >
              Evaluation
            </button>
            <button
              type="button"
              onClick={() => goHome('price')}
              className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
            >
              Price
            </button>
            <button
              type="button"
              onClick={() => goHome('about')}
              className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
            >
              About
            </button>
          </nav>

          <button
            type="button"
            onClick={openSolutionPopup}
            className="px-4 py-2 text-sm font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            Explore Solution
          </button>
        </div>
      </header>

      <main className="flex-1">
        {/* Toast Feedback */}
        {toastMessage && (
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4">
            <div className="flex items-center gap-2 text-sm text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
              <ShieldCheck className="w-4 h-4 text-emerald-700 shrink-0" />
              <span>{toastMessage}</span>
            </div>
          </div>
        )}

        {authError && (
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4">
            <div className="text-sm text-rose-900 bg-rose-50 border border-rose-200 rounded-xl px-4 py-2.5">
              {authError}
            </div>
          </div>
        )}

        {/* VIEW 1: DEDICATED ACTIVE MODULE (ONLY opens when a specific Solution item or Evaluation is clicked) */}
        {activeModule !== null ? (
          <section className="py-10 sm:py-14 bg-slate-50">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6">
              {/* Module Top Bar */}
              <div className="bg-white border border-slate-200 rounded-2xl px-5 py-4 flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => goHome()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 whitespace-nowrap"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    Back to Home
                  </button>
                  <span className="text-slate-300" aria-hidden="true">/</span>
                  <h1 className="text-base sm:text-lg font-bold text-slate-900">
                    {activeModuleTitle}
                  </h1>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {activeModule !== 'evaluation' && (
                    <>
                      <button
                        type="button"
                        onClick={openSolutionPopup}
                        className="px-3.5 py-1.5 text-xs font-semibold text-slate-800 bg-slate-100 rounded-lg hover:bg-slate-200 whitespace-nowrap"
                      >
                        Switch Solution
                      </button>
                      {(activeModule === 'upload' || activeModule === 'vault') && (
                        <button
                          type="button"
                          onClick={() =>
                            setActiveModule(activeModule === 'upload' ? 'vault' : 'upload')
                          }
                          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-teal-800 bg-teal-50 border border-teal-200 rounded-lg hover:bg-teal-100 whitespace-nowrap"
                        >
                          <FolderLock className="w-3.5 h-3.5" />
                          {activeModule === 'upload' ? 'Open Document Vault' : 'Upload New Document'}
                        </button>
                      )}
                    </>
                  )}

                  {!isSignedIn && (
                    <button
                      type="button"
                      onClick={handleSignIn}
                      disabled={signingIn}
                      className="px-4 py-1.5 text-xs font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800 whitespace-nowrap"
                    >
                      {signingIn ? 'Signing in...' : 'Sign in with Google Workspace'}
                    </button>
                  )}
                </div>
              </div>

              {/* Render ONLY the selected tool */}
              {activeModule === 'search' && (
                <AskView
                  isSignedIn={isSignedIn}
                  onRequireSignIn={handleSignIn}
                  signingIn={signingIn}
                  searchInputRef={searchInputRef}
                  authorizedDocs={visibleDocuments}
                  userUid={activeUid}
                  userEmail={activeEmail}
                  effectiveRole={effectiveRole}
                  onOpenUpload={() => setActiveModule('upload')}
                  onInspectCitation={(docItem, pageNum, quote) => {
                    setInspectedDoc(docItem);
                    setHighlightPage(pageNum);
                    setHighlightQuote(quote);
                  }}
                />
              )}

              {activeModule === 'upload' && (
                <InlineUploadPanel
                  isSignedIn={isSignedIn}
                  onRequireSignIn={handleSignIn}
                  userUid={activeUid}
                  userEmail={activeEmail}
                  userRole={effectiveRole}
                  roleGrants={roleGrants}
                  userProfiles={userProfiles}
                  onUploaded={(_docId, docTitle) => {
                    showToast(`Indexed "${docTitle}" with verified page chunks.`);
                    setActiveModule('search');
                  }}
                />
              )}

              {activeModule === 'vault' && (
                <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8">
                  {isSignedIn ? (
                    <VaultView
                      documents={visibleDocuments}
                      onInspectDocument={(docItem) => {
                        setInspectedDoc(docItem);
                        setHighlightPage(undefined);
                        setHighlightQuote(undefined);
                      }}
                      onOpenUpload={() => setActiveModule('upload')}
                    />
                  ) : (
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <p className="text-sm text-slate-700">
                        Sign in with Google Workspace to inspect uploaded documents and page chunks.
                      </p>
                      <button
                        type="button"
                        onClick={handleSignIn}
                        className="px-5 py-2.5 text-sm font-semibold text-white bg-slate-900 rounded-xl hover:bg-slate-800 whitespace-nowrap"
                      >
                        Sign in to View Vault
                      </button>
                    </div>
                  )}
                </div>
              )}

              {activeModule === 'rbac' && (
                <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8">
                  {isSignedIn ? (
                    <AccessControlView
                      mode="rbac"
                      isTrueAdmin={isTrueAdmin}
                      userUid={activeUid}
                      userEmail={activeEmail}
                      effectiveRole={effectiveRole}
                      roleGrants={roleGrants}
                      userProfiles={userProfiles}
                      documents={visibleDocuments}
                      auditLogs={auditLogs}
                      onInspectDocument={(docItem) => {
                        setInspectedDoc(docItem);
                        setHighlightPage(undefined);
                        setHighlightQuote(undefined);
                      }}
                    />
                  ) : (
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <p className="text-sm text-slate-700">
                        Sign in to configure role grants, document transmission controls, and audit logs.
                      </p>
                      <button
                        type="button"
                        onClick={handleSignIn}
                        className="px-5 py-2.5 text-sm font-semibold text-white bg-slate-900 rounded-xl hover:bg-slate-800 whitespace-nowrap"
                      >
                        Sign in to Manage RBAC
                      </button>
                    </div>
                  )}
                </div>
              )}

              {activeModule === 'connectors' && (
                <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8">
                  {isSignedIn ? (
                    <ConnectorsView
                      connectors={connectors}
                      userUid={activeUid}
                      userEmail={activeEmail}
                      effectiveRole={effectiveRole}
                      roleGrants={roleGrants}
                      userProfiles={userProfiles}
                      onSyncedDocument={(title) =>
                        showToast(`Synced and indexed "${title}" into your Document Vault.`)
                      }
                    />
                  ) : (
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <p className="text-sm text-slate-700">
                        Sign in to integrate Confluence, Notion, Slack exports, or REST API knowledge feeds.
                      </p>
                      <button
                        type="button"
                        onClick={handleSignIn}
                        className="px-5 py-2.5 text-sm font-semibold text-white bg-slate-900 rounded-xl hover:bg-slate-800 whitespace-nowrap"
                      >
                        Sign in to Integrate Tools
                      </button>
                    </div>
                  )}
                </div>
              )}

              {activeModule === 'evaluation' && (
                <EvaluationSection
                  isSignedIn={isSignedIn}
                  onRequireSignIn={handleSignIn}
                  authorizedDocs={visibleDocuments}
                  onGoToUpload={() => setActiveModule('upload')}
                />
              )}
            </div>
          </section>
        ) : (
          /* VIEW 2: PURE CLEAN HOME PAGE (Zero search bar, upload, RBAC, or evaluation test-case clutter!) */
          <>
            {/* Hero Section */}
            <section
              id="home"
              className="relative overflow-hidden py-20 sm:py-28 text-white"
              style={{
                background:
                  'radial-gradient(ellipse 75% 65% at 50% 0%, rgba(13, 148, 136, 0.18), rgba(30, 41, 59, 0.45) 55%, #0F172A 100%)',
              }}
            >
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 h-44 opacity-20"
                style={{
                  backgroundImage:
                    'repeating-linear-gradient(90deg, rgba(255,255,255,0.1) 0 1px, transparent 1px 110px)',
                  transform: 'perspective(600px) rotateX(55deg)',
                  transformOrigin: 'bottom',
                }}
              />

              <div className="relative max-w-4xl mx-auto px-4 sm:px-6 text-center space-y-6">
                <div className="text-xs font-mono uppercase tracking-[0.22em] text-teal-300 font-semibold">
                  AI Power Knowledge Management
                </div>

                <h1
                  className="font-bold tracking-tight leading-[1.1] text-white"
                  style={{ fontSize: 'clamp(2.35rem, 4.5vw, 3.75rem)' }}
                >
                  Enterprise Memory for Trusted AI
                </h1>

                <p className="text-base sm:text-lg text-slate-300 leading-relaxed max-w-2xl mx-auto">
                  Access everything you need across company documents, reports, emails, and connected tools, all in one AI powered knowledge platform.
                </p>

                <div className="pt-2 flex flex-wrap items-center justify-center gap-4">
                  <button
                    type="button"
                    onClick={openSolutionPopup}
                    className="inline-flex items-center gap-2 px-7 py-3.5 text-sm font-semibold text-slate-900 bg-teal-300 rounded-xl hover:bg-teal-200 transition-colors whitespace-nowrap"
                  >
                    <span>Explore Solution</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                  <a
                    href="#product"
                    className="inline-flex items-center gap-2 px-6 py-3.5 text-sm font-semibold text-white border border-white/20 rounded-xl hover:bg-white/10 transition-colors whitespace-nowrap"
                  >
                    View Product
                  </a>
                </div>
              </div>
            </section>

            {/* Trusted By Strip: TCS, Wipro, Infosys, Zomato, Swiggy */}
            <section className="bg-white py-14 border-b border-slate-200">
              <div className="max-w-6xl mx-auto px-4 sm:px-6 text-center space-y-9">
                <div className="space-y-2.5">
                  <div className="text-xs font-mono tracking-[0.22em] uppercase text-slate-500 font-semibold">
                    Trusted By Leading Enterprises
                  </div>
                  <div className="mx-auto h-1 w-36 bg-gradient-to-r from-teal-600 via-sky-500 to-slate-200 rounded-full" />
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-8 items-center justify-items-center text-slate-700">
                  <div className="text-2xl font-extrabold tracking-widest text-slate-800">TCS</div>
                  <div className="text-2xl font-bold tracking-tight text-slate-700">Wipro</div>
                  <div className="text-2xl font-bold tracking-tight text-slate-800">Infosys</div>
                  <div className="text-2xl font-black italic tracking-tight text-slate-800">zomato</div>
                  <div className="text-2xl font-extrabold tracking-tight text-slate-700">Swiggy</div>
                </div>
              </div>
            </section>

            {/* Why AI Pilots Fail */}
            <section className="py-16 sm:py-20 bg-slate-900 text-white border-b border-slate-800">
              <div className="max-w-7xl mx-auto px-4 sm:px-6 space-y-10">
                <h2 className="text-center text-2xl sm:text-3xl font-light tracking-tight max-w-3xl mx-auto leading-snug">
                  <strong className="font-bold text-teal-300">95% of enterprise AI pilots</strong> stall before production due to broken knowledge memory.
                </h2>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
                  {MEMORY_CHALLENGES.map((item) => (
                    <div
                      key={item.title}
                      className="bg-slate-800/60 border border-slate-700/70 rounded-2xl p-5 space-y-2 text-center"
                    >
                      <AlertCircle className="w-5 h-5 text-teal-300 mx-auto" />
                      <h3 className="text-sm font-semibold text-white">{item.title}</h3>
                      <p className="text-xs text-slate-300 leading-relaxed">{item.body}</p>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {/* Without Solitiz vs With Solitiz Comparison */}
            <section className="py-16 sm:py-20 bg-slate-50 border-b border-slate-200">
              <div className="max-w-6xl mx-auto px-4 sm:px-6 space-y-8">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
                    How Solitiz Transforms Enterprise Memory
                  </h2>

                  <div className="flex items-center gap-1 p-1 bg-white border border-slate-200 rounded-xl self-start">
                    <button
                      type="button"
                      onClick={() => setComparisonMode('without')}
                      className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                        comparisonMode === 'without'
                          ? 'bg-slate-900 text-white'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Without Solitiz
                    </button>
                    <button
                      type="button"
                      onClick={() => setComparisonMode('with')}
                      className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                        comparisonMode === 'with'
                          ? 'bg-teal-700 text-white'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      With Solitiz
                    </button>
                  </div>
                </div>

                <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
                  <div className="px-6 py-4 border-b border-slate-200 flex items-center gap-2 text-base font-semibold text-slate-900">
                    {comparisonMode === 'without' ? (
                      <>
                        <XCircle className="w-5 h-5 text-rose-600" />
                        <span>Without Solitiz</span>
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="w-5 h-5 text-teal-700" />
                        <span>With Solitiz Knowledge Layer</span>
                      </>
                    )}
                  </div>

                  {comparisonMode === 'without' ? (
                    <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-slate-200">
                      <div className="p-6 space-y-1.5">
                        <div className="text-sm font-semibold text-slate-900">Data is siloed</div>
                        <p className="text-sm text-slate-600">Scattered across drives, PDFs, and chats with no access structure.</p>
                      </div>
                      <div className="p-6 space-y-1.5">
                        <div className="text-sm font-semibold text-slate-900">Answers are unverified</div>
                        <p className="text-sm text-slate-600">Models guess missing details without exact page evidence.</p>
                      </div>
                      <div className="p-6 space-y-1.5">
                        <div className="text-sm font-semibold text-slate-900">Compliance lags</div>
                        <p className="text-sm text-slate-600">Sensitive PII and role permissions remain manual.</p>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-slate-200">
                      <div className="p-6 space-y-1.5">
                        <div className="text-sm font-semibold text-teal-800">Centrally indexed</div>
                        <p className="text-sm text-slate-700">Every PDF and synced tool is organized by role and department.</p>
                      </div>
                      <div className="p-6 space-y-1.5">
                        <div className="text-sm font-semibold text-teal-800">Verbatim verified</div>
                        <p className="text-sm text-slate-700">Quotes are checked word-for-word against source pages.</p>
                      </div>
                      <div className="p-6 space-y-1.5">
                        <div className="text-sm font-semibold text-teal-800">Policy governed</div>
                        <p className="text-sm text-slate-700">Automatic PII masking and RBAC enforced on every query.</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </section>

            {/* Product Architecture (#product) */}
            <section id="product" className="py-16 sm:py-20 bg-slate-900 text-white border-b border-slate-800">
              <div className="max-w-6xl mx-auto px-4 sm:px-6 space-y-12">
                <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
                  <div className="space-y-2 max-w-2xl">
                    <div className="text-xs font-mono font-semibold uppercase tracking-widest text-teal-300">
                      Product Architecture
                    </div>
                    <h2 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">
                      Tap Into Enterprise Knowledge Intelligently
                    </h2>
                  </div>

                  <button
                    type="button"
                    onClick={() => setShowTrendsDrawer((v) => !v)}
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-900 bg-teal-300 rounded-lg hover:bg-teal-200 transition-colors whitespace-nowrap shrink-0 self-start"
                  >
                    <BarChart3 className="w-4 h-4" />
                    {showTrendsDrawer ? 'Hide Search Trends' : 'View Search Trends'}
                  </button>
                </div>

                <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
                  {ARCHITECTURE_TABS.map((tab, idx) => {
                    const active = archTab === tab.id;
                    const Icon =
                      idx === 0 ? Database : idx === 1 ? Layers : idx === 2 ? Shield : Search;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setArchTab(tab.id)}
                        className="text-left space-y-2.5 group"
                      >
                        <Icon
                          className={`w-5 h-5 transition-colors ${
                            active ? 'text-teal-300' : 'text-slate-400 group-hover:text-white'
                          }`}
                        />
                        <div
                          className={`text-sm font-medium transition-colors ${
                            active ? 'text-teal-300' : 'text-slate-300 group-hover:text-white'
                          }`}
                        >
                          {tab.label}
                        </div>
                        <div className="h-1 w-full bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full transition-all duration-300 ${
                              active ? 'w-1/2 bg-teal-300' : 'w-0'
                            }`}
                          />
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
                  <div className="lg:col-span-6">
                    <div className="rounded-2xl overflow-hidden border border-slate-700 bg-slate-950 aspect-4/3">
                      {!imageErrorMap[currentArch.imageSrc] ? (
                        <img
                          src={currentArch.imageSrc}
                          alt={currentArch.imageAlt}
                          referrerPolicy="no-referrer"
                          onError={() =>
                            setImageErrorMap((prev) => ({ ...prev, [currentArch.imageSrc]: true }))
                          }
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center p-8 text-center bg-slate-800 space-y-2">
                          <Layers className="w-8 h-8 text-teal-300" />
                          <span className="text-sm font-semibold text-white">{currentArch.heading}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="lg:col-span-6 space-y-4 lg:pl-4">
                    <h3 className="text-2xl font-bold text-white tracking-tight">
                      {currentArch.heading}
                    </h3>
                    <p className="text-base text-slate-300 leading-relaxed">
                      {currentArch.description}
                    </p>
                    <div className="pt-2 flex flex-wrap items-center gap-6">
                      <button
                        type="button"
                        onClick={() => setArchTab(currentArch.nextTab)}
                        className="inline-flex items-center gap-2 text-sm font-semibold text-teal-300 hover:text-white transition-colors"
                      >
                        <span>{currentArch.nextLabel}</span>
                        <ArrowRight className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={openSolutionPopup}
                        className="text-sm font-medium text-slate-200 hover:text-white underline underline-offset-4"
                      >
                        Explore Solution
                      </button>
                    </div>
                  </div>
                </div>

                {showTrendsDrawer && (
                  <div className="bg-white text-slate-900 border border-slate-200 rounded-2xl p-5 sm:p-7">
                    <SearchTrendsView
                      searchEvents={searchEvents}
                      auditLogs={auditLogs}
                      onGoToAsk={() => selectSolutionItem('search')}
                      onOpenUpload={() => selectSolutionItem('upload')}
                    />
                  </div>
                )}
              </div>
            </section>

            {/* Price Section (#price) */}
            <section id="price" className="py-16 sm:py-20 bg-white border-b border-slate-200">
              <div className="max-w-7xl mx-auto px-4 sm:px-6 space-y-10">
                <div className="space-y-2 max-w-2xl">
                  <div className="text-xs font-mono font-semibold uppercase tracking-widest text-teal-700">
                    Pricing
                  </div>
                  <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
                    Transparent Plans for Enterprise Governance
                  </h2>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  {PRICING_TIERS.map((tier) => (
                    <div
                      key={tier.name}
                      className={`rounded-2xl p-7 flex flex-col justify-between gap-6 border ${
                        tier.highlighted
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-slate-50 text-slate-900 border-slate-200'
                      }`}
                    >
                      <div className="space-y-5">
                        <div className="space-y-1.5">
                          <div
                            className={`text-xs font-mono uppercase tracking-wider font-semibold ${
                              tier.highlighted ? 'text-teal-300' : 'text-teal-700'
                            }`}
                          >
                            {tier.audience}
                          </div>
                          <h3 className="text-xl font-bold">{tier.name}</h3>
                          <div className="flex items-baseline gap-1.5 pt-2">
                            <span className="text-3xl font-bold font-mono tabular-nums">
                              {tier.price}
                            </span>
                            <span
                              className={`text-sm ${
                                tier.highlighted ? 'text-slate-300' : 'text-slate-600'
                              }`}
                            >
                              {tier.cadence}
                            </span>
                          </div>
                        </div>

                        <p
                          className={`text-sm leading-relaxed ${
                            tier.highlighted ? 'text-slate-300' : 'text-slate-600'
                          }`}
                        >
                          {tier.summary}
                        </p>

                        <ul
                          className={`space-y-2 pt-4 border-t text-xs sm:text-sm font-mono tabular-nums ${
                            tier.highlighted
                              ? 'border-slate-700 text-slate-200'
                              : 'border-slate-200 text-slate-700'
                          }`}
                        >
                          {tier.specs.map((spec) => (
                            <li key={spec} className="flex items-start gap-2">
                              <CheckCircle2
                                className={`w-4 h-4 mt-0.5 shrink-0 ${
                                  tier.highlighted ? 'text-teal-300' : 'text-teal-700'
                                }`}
                              />
                              <span>{spec}</span>
                            </li>
                          ))}
                        </ul>
                      </div>

                      <button
                        type="button"
                        onClick={openSolutionPopup}
                        className={`w-full py-2.5 px-4 text-sm font-semibold rounded-xl transition-colors ${
                          tier.highlighted
                            ? 'bg-teal-300 text-slate-900 hover:bg-teal-200'
                            : 'bg-slate-900 text-white hover:bg-slate-800'
                        }`}
                      >
                        {tier.ctaLabel}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {/* Clean Onboarding & Contact Strip (#contact) */}
            <section id="contact" className="py-16 sm:py-20 bg-slate-900 text-white border-b border-slate-800">
              <div className="max-w-6xl mx-auto px-4 sm:px-6 grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
                <div className="lg:col-span-5 space-y-3">
                  <h2 className="text-3xl sm:text-4xl font-light tracking-tight leading-tight">
                    Let&apos;s get started <strong className="font-bold text-teal-300">today.</strong>
                  </h2>
                  <p className="text-sm sm:text-base text-slate-300 leading-relaxed">
                    Request an enterprise walkthrough for your engineering, legal, or operations teams.
                  </p>
                </div>

                <div className="lg:col-span-7">
                  {leadSubmitted ? (
                    <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 space-y-3">
                      <div className="flex items-center gap-2 text-base font-semibold text-teal-300">
                        <CheckCircle2 className="w-5 h-5" />
                        Request Submitted
                      </div>
                      <p className="text-sm text-slate-300">
                        Thank you, {leadFirst} {leadLast}. Our Solitiz onboarding team will follow up at {leadEmail}.
                      </p>
                      <button
                        type="button"
                        onClick={() => setLeadSubmitted(false)}
                        className="px-4 py-2 text-xs font-semibold text-slate-900 bg-teal-300 rounded-lg hover:bg-teal-200"
                      >
                        Send Another Request
                      </button>
                    </div>
                  ) : (
                    <form onSubmit={handleLeadSubmit} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <input
                        type="text"
                        required
                        placeholder="First Name *"
                        value={leadFirst}
                        onChange={(e) => setLeadFirst(e.target.value)}
                        className="h-11 px-3.5 text-sm text-slate-900 bg-white rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-400"
                      />
                      <input
                        type="text"
                        required
                        placeholder="Last Name *"
                        value={leadLast}
                        onChange={(e) => setLeadLast(e.target.value)}
                        className="h-11 px-3.5 text-sm text-slate-900 bg-white rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-400"
                      />
                      <input
                        type="text"
                        required
                        placeholder="Company Name *"
                        value={leadCompany}
                        onChange={(e) => setLeadCompany(e.target.value)}
                        className="h-11 px-3.5 text-sm text-slate-900 bg-white rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-400"
                      />
                      <input
                        type="email"
                        required
                        placeholder="Business Email *"
                        value={leadEmail}
                        onChange={(e) => setLeadEmail(e.target.value)}
                        className="h-11 px-3.5 text-sm text-slate-900 bg-white rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-400"
                      />
                      {leadError && (
                        <div className="sm:col-span-2 text-xs text-rose-200 bg-rose-950/60 border border-rose-500/40 rounded-lg px-3 py-2">
                          {leadError}
                        </div>
                      )}
                      <div className="sm:col-span-2">
                        <button
                          type="submit"
                          className="px-6 py-3 text-sm font-semibold text-slate-900 bg-teal-300 rounded-xl hover:bg-teal-200 transition-colors"
                        >
                          Request Enterprise Access
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              </div>
            </section>

            {/* About Section (#about) — About, Knowledge & Features */}
            <section id="about" className="py-16 sm:py-20 bg-slate-50">
              <div className="max-w-7xl mx-auto px-4 sm:px-6 space-y-12">
                <div className="max-w-3xl space-y-2">
                  <div className="text-xs font-mono font-semibold uppercase tracking-widest text-teal-700">
                    About Solitiz
                  </div>
                  <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
                    AI Power Knowledge Management Built for Enterprise Clarity
                  </h2>
                  <p className="text-sm sm:text-base text-slate-600 leading-relaxed">
                    Solitiz unifies scattered organizational memory into a verified, policy-governed knowledge platform designed for speed, accuracy, and compliance.
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  {/* About */}
                  <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-3">
                    <div className="text-xs font-mono uppercase tracking-wider font-semibold text-teal-700">
                      About
                    </div>
                    <h3 className="text-lg font-semibold text-slate-900">
                      Built for High-Trust Teams
                    </h3>
                    <p className="text-sm text-slate-600 leading-relaxed">
                      Headquartered in Sector 62, Noida, Solitiz helps engineering, legal, and operations teams replace fragmented files and guesswork with verifiable answers.
                    </p>
                  </div>

                  {/* Knowledge */}
                  <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-3">
                    <div className="text-xs font-mono uppercase tracking-wider font-semibold text-teal-700">
                      Knowledge
                    </div>
                    <h3 className="text-lg font-semibold text-slate-900">
                      Unified Memory &amp; Citations
                    </h3>
                    <p className="text-sm text-slate-600 leading-relaxed">
                      Every uploaded PDF, report, email, and synced tool feed is indexed page by page. Answers are grounded strictly in authorized sources with exact quote inspection.
                    </p>
                  </div>

                  {/* Features */}
                  <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-3">
                    <div className="text-xs font-mono uppercase tracking-wider font-semibold text-teal-700">
                      Features
                    </div>
                    <h3 className="text-lg font-semibold text-slate-900">
                      Enterprise Controls Included
                    </h3>
                    <ul className="space-y-2 text-sm text-slate-600">
                      <li className="flex items-start gap-2">
                        <CheckCircle2 className="w-4 h-4 text-teal-700 mt-0.5 shrink-0" />
                        <span>Central Enterprise AI Search &amp; Document Upload</span>
                      </li>
                      <li className="flex items-start gap-2">
                        <CheckCircle2 className="w-4 h-4 text-teal-700 mt-0.5 shrink-0" />
                        <span>Role-Based Access Control (RBAC) &amp; PII Masking</span>
                      </li>
                      <li className="flex items-start gap-2">
                        <CheckCircle2 className="w-4 h-4 text-teal-700 mt-0.5 shrink-0" />
                        <span>Tool Connectors &amp; Live Hallucination Evaluation</span>
                      </li>
                    </ul>
                  </div>
                </div>
              </div>
            </section>
          </>
        )}
      </main>

      {/* Enterprise Light-Gray Structured Footer */}
      <footer className="bg-slate-200/75 border-t border-slate-300 py-14 text-slate-700">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          {/* Top Brand & Contact Band */}
          <div className="pb-10 border-b border-slate-300 flex flex-col lg:flex-row lg:items-end justify-between gap-6">
            <div className="max-w-2xl space-y-2.5">
              <button
                type="button"
                onClick={() => goHome()}
                className="font-display text-xl font-bold tracking-[0.22em] uppercase text-slate-900 hover:text-teal-800 transition-colors"
              >
                SOLITIZ
              </button>
              <p className="font-display text-base font-semibold text-teal-800">
                Your Enterprise Knowledge, One Search Away.
              </p>
              <p className="text-sm text-slate-600 leading-relaxed">
                Find answers across company documents, reports, emails, and connected tools. Search smarter, access information faster, and make better decisions with AI-powered enterprise search.
              </p>
            </div>

            <div className="bg-white/80 border border-slate-300/80 rounded-xl px-4 py-3.5 space-y-2 text-sm shrink-0">
              <a
                href="mailto:support@solitiz.ai"
                className="flex items-center gap-2.5 font-semibold text-slate-900 hover:text-teal-800 transition-colors"
              >
                <Mail className="w-4 h-4 text-teal-700 shrink-0" />
                <span>support@solitiz.ai</span>
              </a>
              <div className="flex items-center gap-2.5 text-xs text-slate-600">
                <MapPin className="w-3.5 h-3.5 text-teal-700 shrink-0" />
                <span>Sector 62, Noida, Uttar Pradesh, India</span>
              </div>
            </div>
          </div>

          {/* 4-Column Structured Links */}
          <div className="py-10 grid grid-cols-2 md:grid-cols-4 gap-8">
            {/* Product */}
            <div className="space-y-3.5">
              <h3 className="font-display text-sm font-bold text-slate-900 tracking-tight">
                Product
              </h3>
              <ul className="space-y-2.5 text-sm text-slate-700">
                <li>
                  <button
                    type="button"
                    onClick={() => selectSolutionItem('search')}
                    className="hover:text-teal-800 transition-colors text-left"
                  >
                    Enterprise Search
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={openEvaluationView}
                    className="hover:text-teal-800 transition-colors text-left"
                  >
                    AI-Powered Answers
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => selectSolutionItem('connectors')}
                    className="hover:text-teal-800 transition-colors text-left"
                  >
                    Connected Sources
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => goHome('product')}
                    className="hover:text-teal-800 transition-colors text-left"
                  >
                    How It Works
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => selectSolutionItem('connectors')}
                    className="hover:text-teal-800 transition-colors text-left"
                  >
                    Integrations
                  </button>
                </li>
              </ul>
            </div>

            {/* Solutions */}
            <div className="space-y-3.5">
              <h3 className="font-display text-sm font-bold text-slate-900 tracking-tight">
                Solutions
              </h3>
              <ul className="space-y-2.5 text-sm text-slate-700">
                <li>
                  <button
                    type="button"
                    onClick={() => selectSolutionItem('search')}
                    className="hover:text-teal-800 transition-colors text-left"
                  >
                    Document Search
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => selectSolutionItem('upload')}
                    className="hover:text-teal-800 transition-colors text-left"
                  >
                    Enterprise Knowledge Management
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => selectSolutionItem('rbac')}
                    className="hover:text-teal-800 transition-colors text-left"
                  >
                    Team Productivity
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={openSolutionPopup}
                    className="hover:text-teal-800 transition-colors text-left"
                  >
                    AI Knowledge Assistant
                  </button>
                </li>
              </ul>
            </div>

            {/* Company */}
            <div className="space-y-3.5">
              <h3 className="font-display text-sm font-bold text-slate-900 tracking-tight">
                Company
              </h3>
              <ul className="space-y-2.5 text-sm text-slate-700">
                <li>
                  <button
                    type="button"
                    onClick={() => goHome('about')}
                    className="hover:text-teal-800 transition-colors text-left"
                  >
                    About Us
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => goHome('contact')}
                    className="hover:text-teal-800 transition-colors text-left"
                  >
                    Contact
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => setFooterInfoTopic('Blog')}
                    className="hover:text-teal-800 transition-colors text-left"
                  >
                    Blog
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => setFooterInfoTopic('Careers')}
                    className="hover:text-teal-800 transition-colors text-left"
                  >
                    Careers
                  </button>
                </li>
              </ul>
            </div>

            {/* Legal */}
            <div className="space-y-3.5">
              <h3 className="font-display text-sm font-bold text-slate-900 tracking-tight">
                Legal
              </h3>
              <ul className="space-y-2.5 text-sm text-slate-700">
                <li>
                  <button
                    type="button"
                    onClick={() => setFooterInfoTopic('Terms of Service')}
                    className="hover:text-teal-800 transition-colors text-left"
                  >
                    Terms of Service
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => setFooterInfoTopic('Privacy Policy')}
                    className="hover:text-teal-800 transition-colors text-left"
                  >
                    Privacy Policy
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => setFooterInfoTopic('Cookie Policy')}
                    className="hover:text-teal-800 transition-colors text-left"
                  >
                    Cookie Policy
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => setFooterInfoTopic('Data Deletion')}
                    className="hover:text-teal-800 transition-colors text-left"
                  >
                    Data Deletion
                  </button>
                </li>
              </ul>
            </div>
          </div>

          {/* Bottom Copyright Bar */}
          <div className="pt-6 border-t border-slate-300 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-600">
            <span className="font-medium text-slate-700">
              © 2026 Solitiz. All rights reserved.
            </span>
            <div className="flex flex-wrap items-center gap-5">
              <button
                type="button"
                onClick={() => setFooterInfoTopic('Terms of Service')}
                className="hover:text-slate-900 transition-colors"
              >
                Terms of Service
              </button>
              <button
                type="button"
                onClick={() => setFooterInfoTopic('Privacy Policy')}
                className="hover:text-slate-900 transition-colors"
              >
                Privacy Policy
              </button>
              <button
                type="button"
                onClick={() => setFooterInfoTopic('Cookie Policy')}
                className="hover:text-slate-900 transition-colors"
              >
                Cookie Policy
              </button>
              <button
                type="button"
                onClick={() => setFooterInfoTopic('Data Deletion')}
                className="hover:text-slate-900 transition-colors"
              >
                Data Deletion
              </button>
            </div>
          </div>
        </div>
      </footer>

      {/* Footer Info & Legal Dialog */}
      {footerInfoTopic && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => setFooterInfoTopic(null)}
        >
          <div
            className="bg-white border border-slate-200 rounded-2xl w-full max-w-lg p-6 sm:p-7 space-y-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 pb-3 border-b border-slate-200">
              <div>
                <div className="text-xs font-mono uppercase tracking-widest text-teal-700 font-semibold">
                  Solitiz Information
                </div>
                <h2 className="font-display text-xl font-bold text-slate-900 mt-1">
                  {footerInfoTopic}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setFooterInfoTopic(null)}
                className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
                aria-label="Close dialog"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="text-sm text-slate-600 leading-relaxed space-y-3">
              {footerInfoTopic === 'Blog' && (
                <p>
                  Read Solitiz engineering notes on verbatim citation verification, RBAC policy design, and zero-hallucination enterprise search at{' '}
                  <a href="mailto:support@solitiz.ai" className="text-teal-700 font-medium underline">
                    support@solitiz.ai
                  </a>.
                </p>
              )}
              {footerInfoTopic === 'Careers' && (
                <p>
                  We are hiring systems engineers, AI evaluation specialists, and frontend designers in Sector 62, Noida. Send your resume to{' '}
                  <a href="mailto:support@solitiz.ai" className="text-teal-700 font-medium underline">
                    support@solitiz.ai
                  </a>.
                </p>
              )}
              {footerInfoTopic === 'Terms of Service' && (
                <p>
                  Solitiz provides role-governed enterprise search over customer-uploaded documents and authorized connectors. Customers retain 100% ownership of all indexed documents and query logs.
                </p>
              )}
              {footerInfoTopic === 'Privacy Policy' && (
                <p>
                  All document chunks are isolated by organization role grants and authenticated user tokens. PII redaction protects sensitive emails, phone numbers, and identifiers during AI transmission.
                </p>
              )}
              {footerInfoTopic === 'Cookie Policy' && (
                <p>
                  Solitiz uses only strictly necessary session storage and Firebase authentication tokens to preserve workspace sign-in state and security permissions.
                </p>
              )}
              {footerInfoTopic === 'Data Deletion' && (
                <p>
                  Document owners and workspace admins can permanently remove uploaded documents and indexed chunks anytime from the Document Vault or Evidence Drawer, or request account deletion via{' '}
                  <a href="mailto:support@solitiz.ai" className="text-teal-700 font-medium underline">
                    support@solitiz.ai
                  </a>.
                </p>
              )}
            </div>

            <div className="pt-2 flex justify-end">
              <button
                type="button"
                onClick={() => setFooterInfoTopic(null)}
                className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SOLUTION POP-UP MODAL (Opens on clicking Solution; user then picks the exact feature to open) */}
      {solutionPopupOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => setSolutionPopupOpen(false)}
        >
          <div
            className="bg-white border border-slate-200 rounded-2xl w-full max-w-2xl p-6 sm:p-8 space-y-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 pb-4 border-b border-slate-200">
              <div>
                <div className="text-xs font-mono uppercase tracking-widest text-teal-700 font-semibold">
                  Solitiz Solutions
                </div>
                <h2 className="text-xl sm:text-2xl font-bold text-slate-900 mt-1">
                  Select a Solution Module
                </h2>
                <p className="text-sm text-slate-600 mt-1">
                  Choose any capability below to launch its dedicated workspace.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSolutionPopupOpen(false)}
                className="p-2 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
                aria-label="Close solution menu"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {SOLUTION_POPUP_ITEMS.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => selectSolutionItem(item.id)}
                    className="text-left bg-slate-50 hover:bg-teal-50/60 border border-slate-200 hover:border-teal-600/40 rounded-xl p-5 flex flex-col justify-between gap-4 transition-colors group"
                  >
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Icon className="w-5 h-5 text-teal-700" />
                        <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-teal-700 group-hover:translate-x-0.5 transition-all" />
                      </div>
                      <div>
                        <h3 className="text-base font-semibold text-slate-900">{item.title}</h3>
                        <p className="text-xs font-mono text-teal-700 mt-0.5">{item.subtitle}</p>
                      </div>
                      <p className="text-xs text-slate-600 leading-relaxed">{item.description}</p>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="pt-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
              <span>Want to test grounding &amp; hallucination rejection?</span>
              <button
                type="button"
                onClick={openEvaluationView}
                className="inline-flex items-center gap-1.5 font-semibold text-teal-700 hover:text-teal-800"
              >
                <FlaskConical className="w-3.5 h-3.5" />
                Open AI Evaluation
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Quick Upload Modal */}
      {isSignedIn && (
        <UploadModal
          open={uploadOpen}
          onClose={() => setUploadOpen(false)}
          userUid={activeUid}
          userEmail={activeEmail}
          userRole={effectiveRole}
          roleGrants={roleGrants}
          userProfiles={userProfiles}
          onUploaded={(_docId, docTitle) => {
            showToast(`Indexed "${docTitle}" with verified page chunks.`);
            selectSolutionItem('search');
          }}
        />
      )}

      {/* Document & Citation Evidence Drawer */}
      {isSignedIn && (
        <DocumentEvidenceDrawer
          document={inspectedDoc}
          highlightPage={highlightPage}
          highlightQuote={highlightQuote}
          onClose={() => setInspectedDoc(null)}
          userUid={activeUid}
          userEmail={activeEmail}
          effectiveRole={effectiveRole}
          isTrueAdmin={isTrueAdmin}
          roleGrants={roleGrants}
          userProfiles={userProfiles}
          onDeleted={() => showToast('Document and indexed chunks deleted.')}
        />
      )}
    </div>
  );
}
