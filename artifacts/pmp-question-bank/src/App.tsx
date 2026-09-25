import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createQuestion as createQuestionRequest,
  getListInstructorQuestionsQueryKey,
  getListBookmarkQuestionsQueryKey,
  getListBookmarksQueryKey,
  getListPracticeSessionsQueryKey,
  getGetPracticeSessionQueryKey,
  getGetInstructorPreferencesQueryKey,
  getListPublishedQuestionsQueryKey,
  useAbandonPracticeSession,
  useCompletePracticeSession,
  useCreatePracticeSession,
  useGetDashboardProgress,
  useGetInProgressPracticeSession,
  useGetLatestPracticeSession,
  useGetPracticeSession,
  useListBookmarks,
  useSavePracticeAnswer,
  useUpdateBookmark,
  useArchiveQuestion,
  useRestoreQuestion,
  useGetInstructorPreferences,
  useListInstructorQuestions,
  useListPublishedQuestions,
  usePublishQuestion,
  useUpdateInstructorPreferences,
  useUpdateQuestion,
} from '@workspace/api-client-react';
import { useAuth, type AuthUser } from '@workspace/replit-auth-web';
import type {
  ListInstructorQuestionsParams,
  ListPublishedQuestionsParams,
  Question,
  QuestionInput,
  DashboardProgress,
  PracticeSession,
} from '@workspace/api-client-react';
import { LibraryPage, ReportsPage } from './components/learner-history';
import { AdminAccessPage } from './components/admin-access';
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Bell,
  BookOpen,
  Bookmark,
  Check,
  ChevronDown,
  Clock3,
  FileQuestion,
  Flag,
  Gauge,
  GraduationCap,
  HelpCircle,
  Home,
  Languages,
  LayoutDashboard,
  ListChecks,
  Menu,
  Moon,
  MoreHorizontal,
  Play,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Target,
  TimerReset,
  Trophy,
  UserRound,
  X,
  Zap,
} from 'lucide-react';

type Page = 'dashboard' | 'setup' | 'session' | 'library' | 'reports' | 'results' | 'review' | 'instructor' | 'admin';
type Language = 'ar' | 'en';
type PracticeMode = 'quick' | 'domain' | 'mock';
type Approach = 'all' | 'agile' | 'predictive' | 'hybrid';

type PmpQuestion = {
  id: string;
  domain: string;
  topic: string;
  approach: Exclude<Approach, 'all'>;
  question: string;
  translation: string;
  options: string[];
  correct: number;
  explanation: string;
};

type Answer = {
  questionId: string;
  selected: number;
};

function getLearnerId() {
  const storageKey = 'pmp-sprint-learner-id';
  if (typeof window === 'undefined') return 'browser-learner';
  const existing = window.localStorage.getItem(storageKey);
  if (existing) return existing;
  const created = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `learner-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  window.localStorage.setItem(storageKey, created);
  return created;
}

function getInitialPage(): Page {
  if (typeof window === 'undefined') return 'dashboard';
  const saved = window.localStorage.getItem('pmp-sprint-page');
  return saved === 'results' || saved === 'review' || saved === 'setup' || saved === 'session' || saved === 'library' || saved === 'reports' || saved === 'instructor' || saved === 'admin' || saved === 'dashboard'
    ? saved
    : 'dashboard';
}

const modeOptions: {
  value: PracticeMode;
  label: string;
  english: string;
  description: string;
  icon: typeof Zap;
}[] = [
  {
    value: 'quick',
    label: 'تدريب سريع',
    english: 'Quick practice',
    description: 'أسئلة قصيرة لتحافظ على الاستمرارية اليومية',
    icon: Zap,
  },
  {
    value: 'domain',
    label: 'حسب المجال',
    english: 'Domain focus',
    description: 'ركّز على مجال يحتاج إلى مزيد من المراجعة',
    icon: Target,
  },
  {
    value: 'mock',
    label: 'اختبار تجريبي',
    english: 'Mock exam',
    description: 'جلسة زمنية تحاكي أجواء الامتحان',
    icon: Trophy,
  },
];

const approachOptions: { value: Approach; label: string }[] = [
  { value: 'all', label: 'كل الأساليب' },
  { value: 'agile', label: 'Agile' },
  { value: 'predictive', label: 'Predictive' },
  { value: 'hybrid', label: 'Hybrid' },
];

const domainOptions = [
  { value: 'all', label: 'كل المجالات' },
  { value: 'People', label: 'People' },
  { value: 'Process', label: 'Process' },
  { value: 'Business environment', label: 'Business environment' },
];

function LogoMark() {
  return (
    <div className="logo-mark" aria-hidden="true">
      <GraduationCap size={19} strokeWidth={2.2} />
    </div>
  );
}

function Pill({
  children,
  tone = 'blue',
}: {
  children: React.ReactNode;
  tone?: 'blue' | 'green' | 'amber' | 'slate' | 'purple';
}) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return <>{text}</>;

  const matcher = new RegExp(`(${escapeRegExp(normalizedQuery)})`, 'gi');
  return (
    <>
      {text.split(matcher).map((part, index) =>
        index % 2 === 1 ? (
          <mark className="search-highlight" key={`${part}-${index}`}>
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

function ProgressRing({ value, size = 112 }: { value: number; size?: number }) {
  const radius = (size - 14) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (value / 100) * circumference;
  return (
    <div className="progress-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          className="progress-ring-track"
          cx={size / 2}
          cy={size / 2}
          r={radius}
        />
        <circle
          className="progress-ring-value"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <strong>{value}%</strong>
    </div>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string; count?: number }[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <span className="select-wrap">
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => (
            <option value={option.value} key={option.value}>
              {option.label}{option.count !== undefined ? ` · ${option.count} سؤال` : ''}
            </option>
          ))}
        </select>
        <ChevronDown size={16} aria-hidden="true" />
      </span>
    </label>
  );
}

function AppShell({
  page,
  setPage,
  children,
  language,
  setLanguage,
  auth,
}: {
  page: Page;
  setPage: (page: Page) => void;
  children: React.ReactNode;
  language: Language;
  setLanguage: (language: Language) => void;
  auth: {
    user: AuthUser | null;
    isLoading: boolean;
    login: () => void;
    logout: () => void;
  };
}) {
  const navItems: { page: Page; label: string; english: string; icon: typeof Home }[] = [
    { page: 'dashboard', label: 'نظرة عامة', english: 'Overview', icon: LayoutDashboard },
    { page: 'setup', label: 'ابدأ التدريب', english: 'Practice', icon: ListChecks },
    { page: 'review', label: 'مراجعة الأخطاء', english: 'Review mistakes', icon: RotateCcw },
    { page: 'instructor', label: 'مساحة المدرّس', english: 'Instructor workspace', icon: GraduationCap },
    ...(auth.user?.role === 'admin' ? [{ page: 'admin' as const, label: 'إدارة الوصول', english: 'Access management', icon: UserRound }] : []),
  ];

  return (
    <div className="app-frame">
      <aside className="sidebar">
        <div className="brand">
          <LogoMark />
          <div>
            <strong>PMP Sprint</strong>
            <span>Question bank</span>
          </div>
        </div>
        <div className="profile-card">
          <div className="avatar">MA</div>
          <div className="profile-copy">
            <strong>{auth.user ? `${auth.user.firstName ?? ''} ${auth.user.lastName ?? ''}`.trim() || 'حسابك' : 'زائر'}</strong>
            <span>{auth.user?.role === 'admin' ? 'Administrator · Access manager' : auth.user?.role === 'instructor' ? 'Instructor · Question author' : 'Learner · PMP candidate'}</span>
          </div>
          <MoreHorizontal size={18} className="muted-icon" />
        </div>
        <nav className="main-nav" aria-label="التنقل الرئيسي">
          <span className="nav-label">مساحة الدراسة</span>
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = page === item.page || (page === 'session' && item.page === 'setup');
            return (
              <button
                type="button"
                className={`nav-item ${active ? 'active' : ''}`}
                onClick={() => setPage(item.page)}
                key={item.page}
              >
                <Icon size={18} />
                <span>
                  <b>{item.label}</b>
                  <small>{item.english}</small>
                </span>
                {active && <span className="nav-dot" />}
              </button>
            );
          })}
          <span className="nav-label nav-label-spaced">المكتبة</span>
          <button type="button" className={`nav-item ${page === 'library' ? 'active' : ''}`} data-testid="button-nav-library" onClick={() => setPage('library')}>
            <BookOpen size={18} />
            <span>
              <b>مكتبتي</b>
              <small>Saved questions</small>
            </span>
          </button>
          <button type="button" className={`nav-item ${page === 'reports' ? 'active' : ''}`} data-testid="button-nav-reports" onClick={() => setPage('reports')}>
            <BarChart3 size={18} />
            <span>
              <b>تقاريري</b>
              <small>My reports</small>
            </span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <button type="button" className="nav-item">
            <Settings2 size={18} />
            <span>
              <b>الإعدادات</b>
              <small>Settings</small>
            </span>
          </button>
          <div className="sidebar-note">
            <Sparkles size={17} />
            <div>
              <strong>خطوة صغيرة اليوم</strong>
              <span>10 أسئلة تحافظ على إيقاعك.</span>
            </div>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <button type="button" className="mobile-menu" aria-label="فتح القائمة">
            <Menu size={20} />
          </button>
          <div className="breadcrumbs">
            <span>PMP Sprint</span>
            <span className="crumb-slash">/</span>
             <strong>{page === 'setup' || page === 'session' ? 'Practice' : page === 'library' ? 'Library' : page === 'reports' ? 'Reports' : page === 'results' || page === 'review' ? 'Results' : page === 'instructor' ? 'Instructor workspace' : page === 'admin' ? 'Access management' : 'Study hub'}</strong>
          </div>
          <div className="topbar-actions">
            <button
              type="button"
              className="language-button"
              onClick={() => setLanguage(language === 'ar' ? 'en' : 'ar')}
              aria-label="تغيير اللغة"
            >
              <Languages size={16} />
              {language === 'ar' ? 'EN' : 'عربي'}
            </button>
            <button type="button" className="icon-button" aria-label="الإشعارات">
              <Bell size={18} />
              <span className="notification-dot" />
            </button>
            <div className="top-avatar">MA</div>
            {auth.isLoading ? (
              <span className="text-button auth-action" aria-live="polite">جارٍ التحقق…</span>
            ) : auth.user ? (
              <button type="button" className="text-button auth-action" onClick={auth.logout}>تسجيل الخروج</button>
            ) : (
              <button type="button" className="text-button auth-action" onClick={auth.login}>تسجيل الدخول</button>
            )}
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}

function Dashboard({
  setPage,
  progress,
  onOpenSession,
  inProgressSessions,
  onContinueSession,
  onAbandonSession,
  abandoningSessionId,
  abandonError,
}: {
  setPage: (page: Page) => void;
  progress: DashboardProgress;
  onOpenSession: (sessionId: string) => void;
  inProgressSessions: PracticeSession[];
  onContinueSession: (sessionId: string) => void;
  onAbandonSession: (sessionId: string) => void;
  abandoningSessionId: string | null;
  abandonError: boolean;
}) {
  const readiness = progress.readinessScore;
  const recentActivity = progress.recentActivity;
  return (
    <div className="page-wrap">
      <section className="page-heading dashboard-heading">
        <div>
          <div className="eyebrow">الأربعاء، 23 سبتمبر 2026 · Week 04</div>
          <h1>أهلًا محمد، جاهز لخطوتك التالية؟</h1>
          <p>استمر على إيقاع هادئ وواضح. كل جلسة تقرّبك من يوم الامتحان.</p>
        </div>
        <button type="button" className="primary-button" onClick={() => setPage('setup')}>
          <Play size={17} fill="currentColor" />
          ابدأ جلسة
        </button>
      </section>

      <section className="dashboard-grid">
        <div className="readiness-card">
          <div className="card-topline">
            <div>
              <span className="card-kicker">جاهزية الامتحان</span>
              <h2>استمر، أنت تتحسن</h2>
            </div>
            <Gauge size={20} />
          </div>
          <div className="readiness-content">
            <ProgressRing value={readiness} />
            <div className="readiness-copy">
              <strong>{readiness} / 100</strong>
              <p>أكملت {progress.questionCount} سؤالًا في جلساتك المحفوظة.</p>
              <span className="positive-text"><ArrowUpIcon /> {progress.completedSessions} جلسات مكتملة</span>
            </div>
          </div>
          <div className="progress-line">
            <span style={{ width: `${readiness}%` }} />
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon blue"><FileQuestion size={19} /></div>
          <span>إجمالي الأسئلة</span>
          <strong>{progress.questionCount}</strong>
          <small>{progress.completedSessions} جلسات مكتملة</small>
        </div>
        <div className="stat-card">
          <div className="stat-icon green"><Clock3 size={19} /></div>
          <span>وقت الدراسة</span>
          <strong>{Math.floor(progress.studyMinutes / 60).toString().padStart(2, '0')}:{(progress.studyMinutes % 60).toString().padStart(2, '0')}</strong>
          <small>من الجلسات المحفوظة</small>
        </div>
        <div className="stat-card">
          <div className="stat-icon purple"><Trophy size={19} /></div>
          <span>متوسط النتيجة</span>
          <strong>{progress.averageScore}%</strong>
          <small>آخر نتيجة: {progress.lastScore === null ? 'لا توجد بعد' : `${progress.lastScore}%`}</small>
        </div>
      </section>

      <section className="dashboard-lower">
        <div className="panel next-session-panel">
          {inProgressSessions.length > 0 ? (
            <>
              <div className="panel-heading">
                <div>
                  <span className="card-kicker">جلسات غير مكتملة · Continue sessions</span>
                  <h2>اختر جلسة للمتابعة</h2>
                </div>
                <Pill tone="amber">{inProgressSessions.length} جلسات</Pill>
              </div>
              {abandonError && (
                <div
                  className="feedback form-error dashboard-abandon-error"
                  data-testid="status-dashboard-abandon-error"
                  role="alert"
                  aria-live="polite"
                >
                  <X size={15} />
                  تعذر التخلي عن الجلسة. بقيت في القائمة؛ حاول مرة أخرى.
                </div>
              )}
              <div className="unfinished-session-list">
                {inProgressSessions.map((session) => (
                  <div className="unfinished-session-item" key={session.id}>
                    <div className="unfinished-session-details">
                      <div className="session-orbit"><RotateCcw size={22} /></div>
                      <div>
                        <h3>{session.mode === 'mock' ? 'اختبار تجريبي' : session.mode === 'domain' ? 'تركيز حسب المجال' : 'تدريب سريع'}</h3>
                        <p>إجاباتك محفوظة. عد إلى السؤال التالي دون بدء جلسة جديدة.</p>
                        <div className="unfinished-session-context" data-testid="unfinished-session-context" dir="rtl">
                          <span>
                            <strong>المجال:</strong>{' '}
                            <bdi>{session.domain && session.domain !== 'all' ? session.domain : 'كل المجالات'}</bdi>
                          </span>
                          <span>
                            <strong>الأسلوب:</strong>{' '}
                            <bdi>
                              {session.approach === 'agile'
                                ? 'Agile'
                                : session.approach === 'predictive'
                                  ? 'Predictive'
                                  : session.approach === 'hybrid'
                                    ? 'Hybrid'
                                    : 'كل الأساليب'}
                            </bdi>
                          </span>
                          <time dateTime={session.startedAt}>
                            <strong>بدأت:</strong>{' '}
                            {new Date(session.startedAt).toLocaleDateString('ar-EG')}
                          </time>
                        </div>
                        <div className="session-tags">
                          <Pill tone="blue">{session.questionIds.length} أسئلة</Pill>
                          <Pill tone="slate">{session.answers.length} تمت الإجابة</Pill>
                          <Pill tone="amber">{session.answers.length} / {session.questionIds.length}</Pill>
                        </div>
                      </div>
                    </div>
                    <div className="unfinished-session-actions">
                      <button
                        type="button"
                        className="secondary-button unfinished-session-button"
                        data-testid="button-continue-session"
                        data-session-id={session.id}
                        disabled={abandoningSessionId === session.id}
                        onClick={() => onContinueSession(session.id)}
                      >
                        متابعة الجلسة <ArrowLeft size={15} />
                      </button>
                      <button
                        type="button"
                        className="secondary-button unfinished-session-button unfinished-session-abandon"
                        data-testid="button-abandon-session"
                        data-session-id={session.id}
                        aria-label={`التخلي عن ${session.mode === 'mock' ? 'الاختبار التجريبي' : session.mode === 'domain' ? 'جلسة التركيز حسب المجال' : 'جلسة التدريب السريع'}`}
                        disabled={abandoningSessionId !== null}
                        onClick={() => onAbandonSession(session.id)}
                      >
                        {abandoningSessionId === session.id ? 'جارٍ التخلي…' : 'التخلي عن الجلسة'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="panel-heading">
                <div>
                  <span className="card-kicker">اقتراحنا لك</span>
                  <h2>جلسة اليوم</h2>
                </div>
                <Pill tone="amber">12 دقيقة</Pill>
              </div>
              <div className="next-session-body">
                <div className="session-orbit"><Target size={26} /></div>
                <div>
                  <h3>Process · Change management</h3>
                  <p>10 أسئلة مختارة من المنطقة التي تحتاج مزيدًا من الثقة.</p>
                  <div className="session-tags">
                    <Pill tone="blue">10 أسئلة</Pill>
                    <Pill tone="slate">متوسط</Pill>
                    <Pill tone="green">+84% آخر مرة</Pill>
                  </div>
                </div>
              </div>
              <button type="button" className="secondary-button full-button" onClick={() => setPage('setup')}>
                ضبط الجلسة <ArrowLeft size={16} />
              </button>
            </>
          )}
        </div>

        <div className="panel activity-panel">
          <div className="panel-heading">
            <div>
              <span className="card-kicker">آخر نشاط</span>
              <h2>تقدمك هذا الأسبوع</h2>
            </div>
            <button type="button" className="text-button" data-testid="button-dashboard-reports" onClick={() => setPage('reports')}>عرض التقارير</button>
          </div>
          {recentActivity.length === 0 ? (
            <div className="empty-review"><BookOpen size={19} /><span>أكمل أول جلسة لتظهر نتائج تقدمك هنا.</span><button type="button" className="text-button" onClick={() => setPage('setup')}>ابدأ تدريبًا جديدًا</button></div>
          ) : (
            <div className="activity-list">
              {recentActivity.map((activity) => (
                <button type="button" className="activity-row" key={activity.sessionId} onClick={() => onOpenSession(activity.sessionId)}>
                  <span className="activity-score">{activity.score}%</span>
                  <span><strong>{activity.questionCount} أسئلة · {activity.mode === 'mock' ? 'اختبار تجريبي' : activity.mode === 'domain' ? 'تركيز حسب المجال' : 'تدريب سريع'}</strong><small>{activity.completionReason === 'time_expired' ? 'انتهى الوقت · أُغلقت تلقائيًا' : 'أُكملت يدويًا'} · {new Date(activity.completedAt).toLocaleDateString('ar-EG')}</small></span>
                  <ArrowLeft size={15} />
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="tip-banner">
        <div className="tip-icon"><Sparkles size={18} /></div>
        <div>
          <strong>نصيحة PMP اليوم</strong>
          <span>قبل اختيار الإجابة، اسأل نفسك: ما الإجراء الذي يحمي قيمة المشروع ويشرك الأشخاص المناسبين؟</span>
        </div>
        <button type="button" className="icon-button ghost"><X size={16} /></button>
      </section>
    </div>
  );
}

function Setup({
  settings,
  setSettings,
  onStart,
  availableQuestions,
  isLoading,
  isError,
  onRetry,
}: {
  settings: {
    mode: PracticeMode;
    domain: string;
    approach: Approach;
    count: number;
    timed: boolean;
  };
  setSettings: React.Dispatch<React.SetStateAction<{
    mode: PracticeMode;
    domain: string;
    approach: Approach;
    count: number;
    timed: boolean;
  }>>;
  onStart: () => void;
  availableQuestions: number;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="page-wrap setup-page">
      <section className="page-heading">
        <div>
          <div className="eyebrow">Practice setup · إعداد الجلسة</div>
          <h1>صمّم جلسة تناسب وقتك اليوم.</h1>
          <p>اختر ما تريد مراجعته وسنرتب لك أسئلة واضحة دون تشتيت.</p>
        </div>
        <div className="setup-help">
          <HelpCircle size={17} />
          <span>جلسة قابلة للتعديل</span>
        </div>
      </section>

      <div className="setup-layout">
        <section className="panel setup-form">
          <div className="section-title">
            <span className="step-number">01</span>
            <div>
              <span className="card-kicker">طريقة التدريب</span>
              <h2>ماذا تريد أن تنجز؟</h2>
            </div>
          </div>
          <div className="mode-grid">
            {modeOptions.map((mode) => {
              const Icon = mode.icon;
              return (
                <button
                  type="button"
                  className={`mode-card ${settings.mode === mode.value ? 'selected' : ''}`}
                  onClick={() => setSettings((current) => ({ ...current, mode: mode.value }))}
                  key={mode.value}
                >
                  <span className="mode-card-icon"><Icon size={19} /></span>
                  <span className="mode-card-copy">
                    <strong>{mode.label}</strong>
                    <small>{mode.english}</small>
                    <em>{mode.description}</em>
                  </span>
                  <span className="radio-indicator">{settings.mode === mode.value && <Check size={13} />}</span>
                </button>
              );
            })}
          </div>

          <div className="form-divider" />
          <div className="section-title compact">
            <span className="step-number">02</span>
            <div>
              <span className="card-kicker">نطاق الأسئلة</span>
              <h2>اضبط تركيزك</h2>
            </div>
          </div>
          <div className="field-grid">
            <SelectField
              label="المجال"
              value={settings.domain}
              options={domainOptions}
              onChange={(domain) => setSettings((current) => ({ ...current, domain }))}
            />
            <SelectField
              label="طريقة تنفيذ المشروع"
              value={settings.approach}
              options={approachOptions}
              onChange={(approach) => setSettings((current) => ({ ...current, approach: approach as Approach }))}
            />
          </div>

          <div className="form-divider" />
          <div className="section-title compact">
            <span className="step-number">03</span>
            <div>
              <span className="card-kicker">الوقت والعدد</span>
              <h2>كم تريد أن تتدرب؟</h2>
            </div>
          </div>
          <div className="count-row">
            <div>
              <span className="field-label">عدد الأسئلة</span>
              <div className="count-options">
                {[10, 20, 30].map((count) => (
                  <button
                    type="button"
                    key={count}
                    className={`count-button ${settings.count === count ? 'selected' : ''}`}
                    onClick={() => setSettings((current) => ({ ...current, count }))}
                  >
                    {count}
                  </button>
                ))}
              </div>
            </div>
            <label className="toggle-row">
              <span className="toggle-copy">
                <strong>وضع الوقت</strong>
                <small>دقيقة لكل سؤال</small>
              </span>
              <button
                type="button"
                className={`toggle ${settings.timed ? 'on' : ''}`}
                onClick={() => setSettings((current) => ({ ...current, timed: !current.timed }))}
                aria-pressed={settings.timed}
              >
                <span />
              </button>
            </label>
          </div>
           <div className="setup-footer">
             <div className={`available-count ${isError ? 'error-text' : ''}`}>
               {isLoading ? <span className="loading-pulse">جارٍ تحميل الأسئلة المنشورة…</span> : isError ? <><X size={15} /> تعذر تحميل الأسئلة <button type="button" className="inline-retry" onClick={onRetry}>إعادة المحاولة</button></> : <><Check size={15} /> {availableQuestions} أسئلة منشورة مناسبة لاختياراتك</>}
             </div>
             <button type="button" className="primary-button start-button" disabled={isLoading || isError || availableQuestions === 0} onClick={onStart}>
              ابدأ الجلسة <ArrowLeft size={17} />
            </button>
          </div>
        </section>

        <aside className="setup-summary">
          <div className="summary-orb"><TimerReset size={27} /></div>
          <span className="card-kicker">ملخص جلستك</span>
          <h2>{settings.mode === 'quick' ? 'تدريب سريع' : settings.mode === 'domain' ? 'تركيز حسب المجال' : 'اختبار تجريبي'}</h2>
          <p>جلسة مرنة مبنية على اختياراتك الحالية.</p>
          <div className="summary-list">
            <div><span><FileQuestion size={16} /> الأسئلة</span><strong>{settings.count}</strong></div>
            <div><span><Target size={16} /> المجال</span><strong>{settings.domain === 'all' ? 'كل المجالات' : settings.domain}</strong></div>
            <div><span><Clock3 size={16} /> الوقت</span><strong>{settings.timed ? `${settings.count} دقيقة` : 'بدون وقت'}</strong></div>
          </div>
          <div className="summary-note">
            <Sparkles size={16} />
            <span>يمكنك إيقاف الجلسة والعودة إليها لاحقًا.</span>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Session({
  settings,
  question,
  questionNumber,
  total,
  selectedChoice,
  setSelectedChoice,
  onNext,
  onAbandon,
  isAbandoning,
  isBookmarked,
  isUpdatingBookmark,
  bookmarkUpdateFailed,
  onToggleBookmark,
  remainingSeconds,
  isCompleting,
  expiryError,
  onRetryCompletion,
}: {
  settings: { timed: boolean };
  question: PmpQuestion;
  questionNumber: number;
  total: number;
  selectedChoice: number | null;
  setSelectedChoice: (choice: number) => void;
  onNext: () => void;
  onAbandon: () => void;
  isAbandoning: boolean;
  isBookmarked: boolean;
  isUpdatingBookmark: boolean;
  bookmarkUpdateFailed: boolean;
  onToggleBookmark: () => void;
  remainingSeconds: number;
  isCompleting: boolean;
  expiryError: unknown;
  onRetryCompletion: () => void;
}) {
  const isAnswered = selectedChoice !== null;
  const minutes = Math.floor(remainingSeconds / 60).toString().padStart(2, '0');
  const seconds = (remainingSeconds % 60).toString().padStart(2, '0');

  return (
    <div className="page-wrap session-page">
      <div className="session-topline">
        <div>
          <div className="eyebrow">جلسة التدريب · Question {questionNumber} of {total}</div>
          <div className="session-meta"><Pill tone="blue">{question.domain}</Pill><Pill tone="slate">{question.topic}</Pill><Pill tone="purple">{question.approach}</Pill></div>
        </div>
        <div className="session-tools">
          {settings.timed && <div className={`timer-chip ${remainingSeconds < 60 ? 'warning' : ''}`}><Clock3 size={16} /> {minutes}:{seconds}</div>}
          <button type="button" className={`icon-button ${isBookmarked ? 'active' : ''}`} onClick={onToggleBookmark} disabled={isUpdatingBookmark} aria-label={isBookmarked ? 'إزالة الحفظ' : 'حفظ السؤال'} aria-pressed={isBookmarked}>
            <Bookmark size={17} fill={isBookmarked ? 'currentColor' : 'none'} />
          </button>
          <button type="button" className="icon-button"><MoreHorizontal size={18} /></button>
        </div>
      </div>
      {bookmarkUpdateFailed && (
        <div
          className="feedback form-error"
          data-testid="status-practice-bookmark-error"
          role="alert"
          aria-live="polite"
        >
          <X size={15} />
          {isBookmarked
            ? 'تعذر إزالة الحفظ. لم يتغير الحفظ؛ يمكنك إعادة المحاولة.'
            : 'تعذر حفظ السؤال. لم يتغير الحفظ؛ يمكنك إعادة المحاولة.'}
          <button
            type="button"
            className="inline-retry"
            data-testid="button-retry-practice-bookmark"
            disabled={isUpdatingBookmark}
            onClick={onToggleBookmark}
          >
            إعادة المحاولة
          </button>
        </div>
      )}
      <div className="question-progress"><span style={{ width: `${(questionNumber / total) * 100}%` }} /></div>

      <section className="question-layout">
        <div className="question-main panel">
          <div className="question-label"><span>Scenario question</span><span className="question-id"># {question.id.replace('q-', '00')}</span></div>
          <h1>{question.question}</h1>
          <p className="question-translation">{question.translation}</p>
          <div className="choices">
            {question.options.map((option, index) => {
              const isSelected = selectedChoice === index;
              const isCorrect = index === question.correct;
              let stateClass = '';
              if (isAnswered && isCorrect) stateClass = 'correct';
              else if (isAnswered && isSelected) stateClass = 'incorrect';
              return (
                <button
                  type="button"
                  key={option}
                  className={`choice ${isSelected ? 'selected' : ''} ${stateClass}`}
                  disabled={isCompleting || (settings.timed && remainingSeconds === 0)}
                  onClick={() => setSelectedChoice(index)}
                  aria-pressed={isSelected}
                >
                  <span className="choice-letter">{String.fromCharCode(65 + index)}</span>
                  <span className="choice-text">{option}</span>
                  {isAnswered && isCorrect && <Check size={18} className="choice-status" />}
                  {isAnswered && isSelected && !isCorrect && <X size={18} className="choice-status" />}
                </button>
              );
            })}
          </div>
          {isAnswered && (
            <div className={`explanation-box ${selectedChoice === question.correct ? 'success' : 'needs-review'}`}>
              <div className="explanation-icon">{selectedChoice === question.correct ? <Check size={16} /> : <HelpCircle size={16} />}</div>
              <div>
                <strong>{selectedChoice === question.correct ? 'إجابة ممتازة' : 'راجع طريقة التفكير'}</strong>
                <p>{question.explanation}</p>
              </div>
            </div>
          )}
          {Boolean(expiryError) && (
            <div className="feedback form-error" data-testid="status-session-completion-error">
              <X size={15} /> تعذر حفظ نتيجة انتهاء الوقت. {String(errorMessage(expiryError))}
              <button type="button" className="inline-retry" onClick={onRetryCompletion}>إعادة المحاولة</button>
            </div>
          )}
          <div className="question-footer">
            <button type="button" className="flag-button"><Flag size={16} /> علّم للمراجعة</button>
            <div className="session-footer-actions">
              <button type="button" className="text-button" disabled={isAbandoning || isCompleting} onClick={onAbandon} aria-label="Abandon session">
                إنهاء الجلسة
              </button>
              <button type="button" className="primary-button" disabled={!isAnswered || isAbandoning || isCompleting || (settings.timed && remainingSeconds === 0)} onClick={onNext}>
                {questionNumber === total ? 'شاهد النتيجة' : 'السؤال التالي'} <ArrowLeft size={17} />
              </button>
            </div>
          </div>
        </div>
        <aside className="question-rail">
          <div className="rail-card">
            <div className="rail-card-heading"><span>تقدم الجلسة</span><strong>{Math.round((questionNumber / total) * 100)}%</strong></div>
            <div className="rail-progress"><span style={{ width: `${(questionNumber / total) * 100}%` }} /></div>
            <div className="question-dots">
              {Array.from({ length: total }).map((_, index) => (
                <span className={`${index + 1 === questionNumber ? 'current' : index + 1 < questionNumber ? 'done' : ''}`} key={index}>{index + 1}</span>
              ))}
            </div>
          </div>
          <div className="rail-card mindset-card">
            <Sparkles size={18} />
            <strong>PMP mindset</strong>
            <p>افهم الموقف قبل أن تبحث عن المصطلح. غالبًا تكون الإجابة الأفضل هي التي تبدأ بالتعاون والتحليل.</p>
          </div>
        </aside>
      </section>
    </div>
  );
}

function Results({
  answers,
  sessionQuestions,
  setPage,
  sessionScore,
  completionReason,
}: {
  answers: Answer[];
  sessionQuestions: PmpQuestion[];
  setPage: (page: Page) => void;
  sessionScore: number | null;
  completionReason: PracticeSession['completionReason'];
}) {
  const calculatedScore = sessionQuestions.length
    ? Math.round((answers.filter((answer) => sessionQuestions.find((question) => question.id === answer.questionId)?.correct === answer.selected).length / sessionQuestions.length) * 100)
    : 0;
  const score = sessionScore ?? calculatedScore;
  const correctCount = answers.filter((answer) => sessionQuestions.find((question) => question.id === answer.questionId)?.correct === answer.selected).length;
  const domains = ['People', 'Process', 'Business environment'];
  const expired = completionReason === 'time_expired';
  const answeredQuestionIds = new Set(answers.map((answer) => answer.questionId));
  const unansweredCount = sessionQuestions.filter((question) => !answeredQuestionIds.has(question.id)).length;
  const questionsById = new Map(sessionQuestions.map((question) => [question.id, question]));
  const domainResults = domains.map((domain) => {
    const domainAnswers = answers.filter((answer) => questionsById.get(answer.questionId)?.domain === domain);
    const correctAnswers = domainAnswers.filter((answer) => questionsById.get(answer.questionId)?.correct === answer.selected).length;
    return {
      domain,
      answers: domainAnswers.length,
      correct: correctAnswers,
      score: domainAnswers.length ? Math.round((correctAnswers / domainAnswers.length) * 100) : null,
    };
  });
  const recommendedDomain = domainResults
    .filter((result) => result.score !== null)
    .sort((left, right) => left.score! - right.score! || right.answers - left.answers)[0] ?? null;
  return (
    <div className="page-wrap results-page">
      <section className="page-heading">
        <div>
          <div className="eyebrow">{expired ? 'Time expired · انتهى الوقت' : 'Session complete · اكتملت الجلسة'}</div>
          <h1>{expired ? 'انتهى الوقت، وهذه نتيجتك المحفوظة.' : 'نتيجة جيدة. الآن حوّلها إلى خطوة واضحة.'}</h1>
          <p>{expired ? 'أُغلقت الجلسة تلقائيًا عند انتهاء الوقت. إجاباتك المحفوظة ونتيجتك متاحة للمراجعة.' : 'راجع ما تعلمته، ثم عد إلى المناطق التي تستطيع رفع نتيجتك فيها.'}</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => setPage('setup')}><RotateCcw size={16} /> جلسة جديدة</button>
      </section>
      <section className="results-top">
        <div className="score-card panel">
          <div className="score-badge"><Trophy size={23} /></div>
          <div>
            <span className="card-kicker">{expired ? 'نتيجتك عند انتهاء الوقت' : 'نتيجتك في هذه الجلسة'}</span>
            <strong className="score-number">{score}%</strong>
            <p>{correctCount} من {sessionQuestions.length} إجابات صحيحة · استمر على نفس الإيقاع.</p>
            {expired && (
              <p className="expired-unanswered-count" data-testid="text-unanswered-count">
                {unansweredCount} من {sessionQuestions.length} أسئلة بلا إجابة
              </p>
            )}
          </div>
          <ProgressRing value={score} size={120} />
        </div>
        <div className="panel recommendation-card">
          <span className="card-kicker">الخطوة المقترحة</span>
          {recommendedDomain ? (
            <>
              <h2 data-testid="text-recommended-domain">راجع {recommendedDomain.domain} قبل جلستك القادمة</h2>
              <p>أجبت بشكل صحيح عن {recommendedDomain.correct} من {recommendedDomain.answers} أسئلة في هذا المجال.</p>
              <button type="button" className="text-button" onClick={() => setPage('review')}>ابدأ المراجعة <ArrowLeft size={15} /></button>
            </>
          ) : (
            <>
              <h2 data-testid="text-neutral-recommendation">واصل التدرّب لتحديد مجال للمراجعة</h2>
              <p>أجب عن أسئلة في جلسة أخرى لنقترح مجالًا بناءً على نتيجتك.</p>
              <button type="button" className="text-button" data-testid="button-start-session-from-recommendation" onClick={() => setPage('setup')}>ابدأ جلسة جديدة <ArrowLeft size={15} /></button>
            </>
          )}
        </div>
      </section>
      <section className="results-grid">
        <div className="panel breakdown-panel">
          <div className="panel-heading"><div><span className="card-kicker">تحليل الأداء</span><h2>حسب المجال</h2></div><Pill tone="green">Live insight</Pill></div>
          <div className="domain-breakdown">
            {domainResults.map(({ domain, score }) => {
              const domainId = domain.toLowerCase().replaceAll(' ', '-');
              return (
                <div className={`domain-row${score === null ? ' unscored' : ''}`} key={domain} data-testid={`domain-row-${domainId}`}>
                  <div>
                    <span>{domain}</span>
                    <strong data-testid={`domain-score-${domainId}`}>{score === null ? 'Not scored' : `${score}%`}</strong>
                  </div>
                  {score === null ? (
                    <p className="domain-unscored-note">لا توجد إجابات في هذا المجال</p>
                  ) : (
                    <div className="domain-bar" aria-label={`${domain} score`}>
                      <span style={{ width: `${score}%` }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="panel next-actions">
          <div className="panel-heading"><div><span className="card-kicker">استفد من الجلسة</span><h2>ماذا بعد؟</h2></div></div>
          <button type="button" className="action-row" onClick={() => setPage('review')}><span className="action-icon amber"><RotateCcw size={17} /></span><span><strong>راجع الإجابات الخاطئة</strong><small>افهم سبب كل اختيار</small></span><ArrowLeft size={16} /></button>
          <button type="button" className="action-row" onClick={() => setPage('setup')}><span className="action-icon blue"><Play size={17} /></span><span><strong>ابدأ جلسة جديدة</strong><small>ثبّت ما تعلمته</small></span><ArrowLeft size={16} /></button>
          <button type="button" className="action-row"><span className="action-icon purple"><Bookmark size={17} /></span><span><strong>احفظ ملخص الجلسة</strong><small>عد إليه في نهاية الأسبوع</small></span><ArrowLeft size={16} /></button>
        </div>
      </section>
    </div>
  );
}

function Review({
  answers,
  sessionQuestions,
  setPage,
  completionReason,
}: {
  answers: Answer[];
  sessionQuestions: PmpQuestion[];
  setPage: (page: Page) => void;
  completionReason: PracticeSession['completionReason'];
}) {
  const reviewItems = answers;
  const expired = completionReason === 'time_expired';
  const answeredQuestionIds = new Set(answers.map((answer) => answer.questionId));
  const unansweredQuestions = expired
    ? sessionQuestions.filter((question) => !answeredQuestionIds.has(question.id))
    : [];
  return (
    <div className="page-wrap review-page">
      <section className="page-heading">
        <div>
          <div className="eyebrow">Review mistakes · مراجعة ذكية</div>
          <h1>الأخطاء ليست نهاية الجلسة.</h1>
          <p>استخدمها لتفهم نمط تفكيرك، لا لحفظ الإجابة فقط.</p>
          {expired && (
            <p className="expired-review-summary" data-testid="text-review-unanswered-summary">
              {unansweredQuestions.length} من {sessionQuestions.length} أسئلة لم تتم الإجابة عنها قبل انتهاء الوقت.
            </p>
          )}
        </div>
        <div className="review-filter"><Search size={16} /><span>آخر جلسة</span><ChevronDown size={15} /></div>
      </section>
      <div className="review-list">
        {reviewItems.map((answer) => {
          const question = sessionQuestions.find((item) => item.id === answer.questionId);
          if (!question) return null;
          const correct = question.correct === answer.selected;
          return <div className="panel review-item" key={question.id}><div className={`review-status ${correct ? 'correct' : 'wrong'}`}>{correct ? <Check size={17} /> : <X size={17} />}</div><div className="review-item-copy"><div className="review-item-meta"><Pill tone={correct ? 'green' : 'amber'}>{correct ? 'صحيح' : 'يحتاج مراجعة'}</Pill><span>{question.domain} · {question.topic}</span></div><h3>{question.question}</h3><p>{question.explanation}</p></div><button type="button" className="icon-button"><ArrowLeft size={17} /></button></div>;
        })}
      </div>
      {unansweredQuestions.length > 0 && (
        <section className="unanswered-review" aria-labelledby="unanswered-review-title">
          <div className="panel-heading">
            <div>
              <span className="card-kicker">انتهى الوقت قبل الإجابة</span>
              <h2 id="unanswered-review-title">أسئلة بلا إجابة</h2>
            </div>
            <Pill tone="amber">{unansweredQuestions.length}</Pill>
          </div>
          <div className="review-list">
            {unansweredQuestions.map((question) => (
              <article className="panel review-item unanswered-review-item" key={question.id} data-testid={`review-unanswered-${question.id}`}>
                <div className="review-status unanswered"><HelpCircle size={17} /></div>
                <div className="review-item-copy">
                  <div className="review-item-meta">
                    <Pill tone="amber">لم تتم الإجابة</Pill>
                    <span>{question.domain} · {question.topic}</span>
                  </div>
                  <h3>{question.question}</h3>
                  <p className="unanswered-correct-answer">
                    الإجابة الصحيحة: {question.options[question.correct]}
                  </p>
                  <p>{question.explanation}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
      {(!expired || unansweredQuestions.length === 0) && (
        <div className="empty-review"><BookOpen size={19} /><span>يمكنك حفظ الأسئلة المهمة لتظهر هنا في أي وقت.</span><button type="button" className="text-button" onClick={() => setPage('setup')}>ابدأ تدريبًا جديدًا</button></div>
      )}
    </div>
  );
}

type InstructorFormState = {
  domain: QuestionInput['domain'];
  topic: string;
  approach: QuestionInput['approach'];
  difficulty: QuestionInput['difficulty'];
  question: string;
  translation: string;
  options: [string, string, string, string];
  correctAnswer: number | null;
  explanation: string;
};

type StoredInstructorDraft = {
  version: 1;
  accountId: string;
  updatedAt: string;
  editingId: string | null;
  form: InstructorFormState;
};

const emptyInstructorForm: InstructorFormState = {
  domain: 'People',
  topic: '',
  approach: 'agile',
  difficulty: 'medium',
  question: '',
  translation: '',
  options: ['', '', '', ''],
  correctAnswer: null,
  explanation: '',
};

function instructorDraftStorageKey(accountId: string) {
  return `pmp-sprint-instructor-draft:v1:${encodeURIComponent(accountId)}`;
}

function isInstructorFormState(value: unknown): value is InstructorFormState {
  if (!value || typeof value !== 'object') return false;
  const form = value as Partial<InstructorFormState>;
  return (
    (form.domain === 'People' || form.domain === 'Process' || form.domain === 'Business environment') &&
    typeof form.topic === 'string' &&
    (form.approach === 'agile' || form.approach === 'predictive' || form.approach === 'hybrid') &&
    (form.difficulty === 'easy' || form.difficulty === 'medium' || form.difficulty === 'hard') &&
    typeof form.question === 'string' &&
    typeof form.translation === 'string' &&
    Array.isArray(form.options) &&
    form.options.length === 4 &&
    form.options.every((option) => typeof option === 'string') &&
    (form.correctAnswer === null ||
      (Number.isInteger(form.correctAnswer) && form.correctAnswer! >= 0 && form.correctAnswer! < 4)) &&
    typeof form.explanation === 'string'
  );
}

function readInstructorDraft(accountId: string): StoredInstructorDraft | null {
  try {
    const key = instructorDraftStorageKey(accountId);
    const stored = window.localStorage.getItem(key);
    if (!stored) return null;
    const value: unknown = JSON.parse(stored);
    if (
      !value ||
      typeof value !== 'object' ||
      (value as StoredInstructorDraft).version !== 1 ||
      (value as StoredInstructorDraft).accountId !== accountId ||
      typeof (value as StoredInstructorDraft).updatedAt !== 'string' ||
      !((value as StoredInstructorDraft).editingId === null ||
        typeof (value as StoredInstructorDraft).editingId === 'string') ||
      !isInstructorFormState((value as StoredInstructorDraft).form)
    ) {
      window.localStorage.removeItem(key);
      return null;
    }
    return value as StoredInstructorDraft;
  } catch {
    return null;
  }
}

function removeInstructorDraft(accountId: string) {
  window.localStorage.removeItem(instructorDraftStorageKey(accountId));
}

function questionToForm(question: Question): InstructorFormState {
  return {
    domain: question.domain,
    topic: question.topic,
    approach: question.approach,
    difficulty: question.difficulty,
    question: question.question,
    translation: question.translation,
    options: [
      question.options[0] ?? '',
      question.options[1] ?? '',
      question.options[2] ?? '',
      question.options[3] ?? '',
    ],
    correctAnswer: question.correctAnswer,
    explanation: question.explanation,
  };
}

function errorMessage(error: unknown) {
  if (error && typeof error === 'object' && 'error' in error) {
    return String((error as { error: unknown }).error);
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'حدث خطأ غير متوقع. حاول مرة أخرى.';
}

function isUnauthorizedError(error: unknown) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'status' in error &&
      ((error as { status?: unknown }).status === 401 ||
        (error as { status?: unknown }).status === 403),
  );
}

function InstructorAccessDenied({ onBack }: { onBack: () => void }) {
  return (
    <div className="page-wrap instructor-page">
      <div className="instructor-state error-state" data-testid="status-instructor-unauthorized">
        <X size={20} />
        <strong>مساحة المدرّس مخصصة للمدرّسين المصرّح لهم فقط</strong>
        <span>لا تملك صلاحية الوصول إلى أدوات تأليف بنك الأسئلة.</span>
        <button type="button" className="secondary-button" onClick={onBack}>
          العودة إلى التدريب
        </button>
      </div>
    </div>
  );
}

const defaultInstructorPageSize = 25;

function InstructorWorkspace({
  onBack,
  accountId,
  canAccess,
}: {
  onBack: () => void;
  accountId: string | null;
  canAccess: boolean;
}) {
  const queryClient = useQueryClient();
  const [instructorPageSize, setInstructorPageSize] = useState(defaultInstructorPageSize);
  const [filters, setFilters] = useState<{
    search: string;
    status: 'all' | Question['status'];
    domain: 'all' | QuestionInput['domain'];
    approach: 'all' | QuestionInput['approach'];
    difficulty: 'all' | QuestionInput['difficulty'];
  }>({ search: '', status: 'all', domain: 'all', approach: 'all', difficulty: 'all' });
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<InstructorFormState>(emptyInstructorForm);
  const [initialForm, setInitialForm] = useState<InstructorFormState>(emptyInstructorForm);
  const [draftOwnerId, setDraftOwnerId] = useState<string | null>(null);
  const [recoveredDraft, setRecoveredDraft] = useState<StoredInstructorDraft | null>(null);
  const [draftStorageError, setDraftStorageError] = useState('');
  const createOperationRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const [validationError, setValidationError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [pageOffset, setPageOffset] = useState(0);
  const [expandedQuestionIds, setExpandedQuestionIds] = useState<Set<string>>(() => new Set());
  const [preferenceSaveError, setPreferenceSaveError] = useState('');

  const preferencesQueryKey = useMemo(
    () => [...getGetInstructorPreferencesQueryKey(), accountId],
    [accountId],
  );
  const preferencesQuery = useGetInstructorPreferences({
    query: {
      queryKey: preferencesQueryKey,
      enabled: canAccess && Boolean(accountId),
    },
  });
  const updatePreferences = useUpdateInstructorPreferences({
    mutation: {
      onSuccess: (preferences) => {
        queryClient.setQueryData(preferencesQueryKey, preferences);
        setPreferenceSaveError('');
      },
    },
  });
  const currentInstructorPageSize = preferencesQuery.data?.pageSize ?? instructorPageSize;

  const changeInstructorPageSize = (pageSize: 10 | 25 | 50) => {
    const previousPageSize = currentInstructorPageSize;
    setPageOffset(0);
    setInstructorPageSize(pageSize);
    setPreferenceSaveError('');
    queryClient.setQueryData(preferencesQueryKey, { pageSize });
    updatePreferences.mutate(
      { data: { pageSize } },
      {
        onError: (error) => {
          queryClient.setQueryData(preferencesQueryKey, { pageSize: previousPageSize });
          setInstructorPageSize(previousPageSize);
          setPreferenceSaveError(errorMessage(error));
        },
      },
    );
  };

  useEffect(() => {
    setInstructorPageSize(defaultInstructorPageSize);
    setPageOffset(0);
    setPreferenceSaveError('');
  }, [accountId]);

  useEffect(() => {
    if (preferencesQuery.data) {
      setInstructorPageSize(preferencesQuery.data.pageSize);
    }
  }, [preferencesQuery.data]);

  const queryParams = useMemo<ListInstructorQuestionsParams>(() => ({
    ...(filters.search.trim() ? { search: filters.search.trim() } : {}),
    ...(filters.status === 'all' ? {} : { status: filters.status }),
    ...(filters.domain === 'all' ? {} : { domain: filters.domain }),
    ...(filters.approach === 'all' ? {} : { approach: filters.approach }),
    ...(filters.difficulty === 'all' ? {} : { difficulty: filters.difficulty }),
    limit: currentInstructorPageSize,
    offset: pageOffset,
  }), [filters, currentInstructorPageSize, pageOffset]);
  const listQuery = useListInstructorQuestions(queryParams, {
    query: {
      queryKey: getListInstructorQuestionsQueryKey(queryParams),
      enabled: !canAccess || preferencesQuery.isSuccess,
    },
  });
  const createQuestion = useMutation({
    mutationFn: ({ data, idempotencyKey }: { data: QuestionInput; idempotencyKey: string }) =>
      createQuestionRequest(data, { headers: { 'Idempotency-Key': idempotencyKey } }),
  });
  const updateQuestion = useUpdateQuestion();
  const publishQuestion = usePublishQuestion();
  const archiveQuestion = useArchiveQuestion();
  const restoreQuestion = useRestoreQuestion();
  const isSaving = createQuestion.isPending || updateQuestion.isPending;
  const isChangingStatus =
    publishQuestion.isPending || archiveQuestion.isPending || restoreQuestion.isPending;
  const accountReady = canAccess && Boolean(accountId) && draftOwnerId === accountId;
  const hasUnsavedChanges =
    accountReady && formOpen && JSON.stringify(form) !== JSON.stringify(initialForm);
  const currentRecoveredDraft = accountReady ? recoveredDraft : null;

  useEffect(() => {
    if (!canAccess || !accountId) {
      setDraftOwnerId(null);
      setRecoveredDraft(null);
      setFormOpen(false);
      setEditingId(null);
      setForm(emptyInstructorForm);
      setInitialForm(emptyInstructorForm);
      return;
    }

    const savedDraft = readInstructorDraft(accountId);
    setFormOpen(false);
    setEditingId(null);
    setForm(emptyInstructorForm);
    setInitialForm(emptyInstructorForm);
    setDraftStorageError('');
    setRecoveredDraft(savedDraft);
    setDraftOwnerId(accountId);
  }, [accountId, canAccess]);

  useEffect(() => {
    if (!accountReady || !accountId || !formOpen || !hasUnsavedChanges) return;
    try {
      const savedDraft: StoredInstructorDraft = {
        version: 1,
        accountId,
        updatedAt: new Date().toISOString(),
        editingId,
        form,
      };
      window.localStorage.setItem(instructorDraftStorageKey(accountId), JSON.stringify(savedDraft));
      setDraftStorageError('');
    } catch {
      setDraftStorageError('تعذر حفظ نسخة استرداد التعديلات على هذا الجهاز.');
    }
  }, [accountId, accountReady, editingId, form, formOpen, hasUnsavedChanges]);

  useEffect(() => {
    if (!hasUnsavedChanges) return;

    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [hasUnsavedChanges]);

  if (listQuery.isLoading) {
    return (
      <div className="page-wrap instructor-page">
        <div className="instructor-state" data-testid="status-instructor-access-loading">
          <div className="instructor-loading"><span /><span /><span /></div>
          <strong>جارٍ التحقق من صلاحية الوصول…</strong>
        </div>
      </div>
    );
  }

  if (isUnauthorizedError(listQuery.error)) {
    return <InstructorAccessDenied onBack={onBack} />;
  }

  const refreshLists = () => {
    void queryClient.invalidateQueries({ queryKey: getListInstructorQuestionsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListPublishedQuestionsQueryKey() });
  };

  const openNewForm = () => {
    createQuestion.reset();
    updateQuestion.reset();
    createOperationRef.current = null;
    setEditingId(null);
    setForm(emptyInstructorForm);
    setInitialForm(emptyInstructorForm);
    setValidationError('');
    setFeedback('');
    setDraftStorageError('');
    setFormOpen(true);
  };

  const openEditForm = (question: Question) => {
    createQuestion.reset();
    updateQuestion.reset();
    createOperationRef.current = null;
    const questionForm = questionToForm(question);
    setEditingId(question.id);
    setForm(questionForm);
    setInitialForm(questionForm);
    setValidationError('');
    setFeedback('');
    setDraftStorageError('');
    setFormOpen(true);
  };

  const resumeRecoveredDraft = () => {
    if (!currentRecoveredDraft) return;
    const originalQuestion = currentRecoveredDraft.editingId
      ? listQuery.data?.items.find((question) => question.id === currentRecoveredDraft.editingId)
      : undefined;
    createQuestion.reset();
    updateQuestion.reset();
    createOperationRef.current = null;
    setEditingId(currentRecoveredDraft.editingId);
    setForm(currentRecoveredDraft.form);
    setInitialForm(originalQuestion ? questionToForm(originalQuestion) : emptyInstructorForm);
    setValidationError('');
    setFeedback('');
    setDraftStorageError('');
    setRecoveredDraft(null);
    setFormOpen(true);
  };

  const discardRecoveredDraft = () => {
    if (!accountId || !currentRecoveredDraft) return;
    try {
      removeInstructorDraft(accountId);
      setRecoveredDraft(null);
      setDraftStorageError('');
    } catch {
      setDraftStorageError('تعذر حذف نسخة الاسترداد. حاول مرة أخرى قبل المتابعة.');
    }
  };

  const handleCloseForm = () => {
    if (
      JSON.stringify(form) !== JSON.stringify(initialForm) &&
      !window.confirm('لديك تغييرات غير محفوظة. هل تريد تجاهلها وإغلاق النموذج؟')
    ) {
      return;
    }
    if (accountId) {
      try {
        removeInstructorDraft(accountId);
        setDraftStorageError('');
      } catch {
        setDraftStorageError('تعذر حذف نسخة الاسترداد. أبقينا النموذج مفتوحًا لحماية تعديلاتك.');
        return;
      }
    }
    setRecoveredDraft(null);
    createOperationRef.current = null;
    setFormOpen(false);
  };

  const updateField = <K extends keyof InstructorFormState>(field: K, value: InstructorFormState[K]) => {
    setForm((current) => ({ ...current, [field]: value }));
    setValidationError('');
  };

  const handleSave = () => {
    const missingOption = form.options.some((option) => !option.trim());
    if (
      !form.topic.trim() ||
      !form.question.trim() ||
      !form.translation.trim() ||
      !form.explanation.trim() ||
      missingOption ||
      form.correctAnswer === null
    ) {
      setValidationError('أكمل كل الحقول واختر الإجابة الصحيحة قبل الحفظ.');
      return;
    }
    const payload: QuestionInput = {
      domain: form.domain,
      topic: form.topic.trim(),
      approach: form.approach,
      difficulty: form.difficulty,
      question: form.question.trim(),
      translation: form.translation.trim(),
      options: form.options.map((option) => option.trim()),
      correctAnswer: form.correctAnswer,
      explanation: form.explanation.trim(),
    };
    setValidationError('');
    setFeedback('');
    const onSuccess = () => {
      if (accountId) {
        try {
          removeInstructorDraft(accountId);
          setDraftStorageError('');
        } catch {
          setDraftStorageError('حُفظ السؤال، لكن تعذر حذف نسخة الاسترداد القديمة من هذا الجهاز.');
        }
      }
      setRecoveredDraft(null);
      refreshLists();
      setFormOpen(false);
      setFeedback(editingId ? 'تم تحديث السؤال بنجاح.' : 'تم حفظ المسودة بنجاح.');
    };
    if (editingId) {
      updateQuestion.mutate({ id: editingId, data: payload }, { onSuccess });
    } else {
      const fingerprint = JSON.stringify(payload);
      let operation = createOperationRef.current;
      if (!operation || operation.fingerprint !== fingerprint) {
        operation = { fingerprint, key: crypto.randomUUID() };
        createOperationRef.current = operation;
      }
      const onCreateSuccess = () => {
        createOperationRef.current = null;
        onSuccess();
      };
      createQuestion.mutate(
        { data: payload, idempotencyKey: operation.key },
        { onSuccess: onCreateSuccess },
      );
    }
  };

  const handleStatusChange = (question: Question, action: 'publish' | 'archive' | 'restore') => {
    publishQuestion.reset();
    archiveQuestion.reset();
    restoreQuestion.reset();
    setFeedback('');
    const onSuccess = () => {
      refreshLists();
      setFeedback(
        action === 'publish'
          ? 'تم نشر السؤال.'
          : action === 'archive'
            ? 'تمت أرشفة السؤال.'
            : 'تمت استعادة السؤال كمسودة للمراجعة قبل النشر.',
      );
    };
    if (action === 'publish') publishQuestion.mutate({ id: question.id }, { onSuccess });
    else if (action === 'archive') archiveQuestion.mutate({ id: question.id }, { onSuccess });
    else restoreQuestion.mutate({ id: question.id }, { onSuccess });
  };

  const items = listQuery.data?.items ?? [];
  const pagination = listQuery.data?.pagination;

  return (
    <div className="page-wrap instructor-page">
      <section className="page-heading instructor-heading">
        <div>
          <div className="eyebrow">Instructor workspace · مساحة المدرّس</div>
          <h1>حرّر بنك الأسئلة بثقة ووضوح.</h1>
          <p>أنشئ سيناريوهات PMP، راجعها، ثم انشرها للمتعلمين عندما تصبح جاهزة.</p>
        </div>
        <button type="button" className="primary-button" data-testid="button-new-question" onClick={openNewForm}>
          <FileQuestion size={17} /> سؤال جديد
        </button>
      </section>

      <div className="instructor-banner">
        <div className="instructor-badge"><GraduationCap size={18} /></div>
        <div><strong>أنت تكتب للمحتوى التعليمي</strong><span>المسودات لا تظهر في تدريب المتعلم حتى تضغط «نشر».</span></div>
        <Pill tone="blue">{pagination?.total ?? items.length} سؤال في العرض</Pill>
      </div>

      <section className="panel instructor-panel">
        <div className="instructor-toolbar">
          <div>
            <span className="card-kicker">Question library</span>
            <h2>بنك الأسئلة</h2>
          </div>
          <div className="instructor-filters">
            <label className="instructor-search">البحث<input data-testid="input-filter-search" value={filters.search} onChange={(event) => { setPageOffset(0); setFilters((current) => ({ ...current, search: event.target.value })); }} placeholder="الموضوع أو نص السؤال" /></label>
            <label>الحالة<select data-testid="select-filter-status" value={filters.status} onChange={(event) => { setPageOffset(0); setFilters((current) => ({ ...current, status: event.target.value as typeof filters.status })); }}><option value="all">كل الحالات</option><option value="draft">مسودة</option><option value="published">منشور</option><option value="archived">مؤرشف</option></select></label>
            <label>المجال<select data-testid="select-filter-domain" value={filters.domain} onChange={(event) => { setPageOffset(0); setFilters((current) => ({ ...current, domain: event.target.value as typeof filters.domain })); }}><option value="all">كل المجالات</option><option value="People">People</option><option value="Process">Process</option><option value="Business environment">Business environment</option></select></label>
            <label>الأسلوب<select data-testid="select-filter-approach" value={filters.approach} onChange={(event) => { setPageOffset(0); setFilters((current) => ({ ...current, approach: event.target.value as typeof filters.approach })); }}><option value="all">كل الأساليب</option><option value="agile">Agile</option><option value="predictive">Predictive</option><option value="hybrid">Hybrid</option></select></label>
            <label>الصعوبة<select data-testid="select-filter-difficulty" value={filters.difficulty} onChange={(event) => { setPageOffset(0); setFilters((current) => ({ ...current, difficulty: event.target.value as typeof filters.difficulty })); }}><option value="all">كل المستويات</option><option value="easy">سهل</option><option value="medium">متوسط</option><option value="hard">صعب</option></select></label>
             <label className="instructor-page-size">عدد الأسئلة في الصفحة<select data-testid="select-page-size" value={currentInstructorPageSize} disabled={preferencesQuery.isLoading || preferencesQuery.isError || updatePreferences.isPending} onChange={(event) => changeInstructorPageSize(Number(event.target.value) as 10 | 25 | 50)}><option value={10}>10</option><option value={25}>25</option><option value={50}>50</option></select></label>
          </div>
        </div>

        {preferencesQuery.isLoading && <div className="feedback" data-testid="status-instructor-preference-loading">جارٍ تحميل تفضيلات مساحة المدرّس…</div>}
        {preferencesQuery.isError && <div className="feedback form-error" data-testid="status-instructor-preference-error" role="alert" aria-live="polite"><X size={15} /> تعذر تحميل تفضيلات الصفحة. <button type="button" className="inline-retry" onClick={() => void preferencesQuery.refetch()}>إعادة المحاولة</button></div>}
        {preferenceSaveError && <div className="feedback form-error" data-testid="status-instructor-preference-save-error" role="alert" aria-live="polite"><X size={15} /> تعذر حفظ تفضيل الصفحة. {preferenceSaveError}</div>}
        {draftStorageError && <div className="feedback form-error" data-testid="status-question-recovery-storage-error" role="alert" aria-live="polite"><X size={15} /> {draftStorageError}</div>}
        {feedback && <div className="feedback success-feedback" data-testid="status-instructor-feedback"><Check size={15} /> {feedback}</div>}
        {(publishQuestion.isError || archiveQuestion.isError || restoreQuestion.isError) && <div className="feedback form-error" data-testid="status-instructor-action-error" role="alert" aria-live="polite"><X size={15} /> {errorMessage(publishQuestion.error ?? archiveQuestion.error ?? restoreQuestion.error)}</div>}
        {listQuery.isLoading && <div className="instructor-loading"><span /><span /><span /></div>}
        {listQuery.isError && <div className="instructor-state error-state" data-testid="status-instructor-error"><X size={20} /><strong>تعذر تحميل بنك الأسئلة</strong><span>{errorMessage(listQuery.error)}</span><button type="button" className="secondary-button" onClick={() => void listQuery.refetch()}>إعادة المحاولة</button></div>}
         {!listQuery.isLoading && !listQuery.isError && items.length === 0 && pagination?.total === 0 && <div className="instructor-state" data-testid="status-instructor-empty"><BookOpen size={24} /><strong>{filters.search.trim() ? 'لا توجد أسئلة تطابق البحث' : 'لا توجد أسئلة بهذا الفلتر'}</strong><span>{filters.search.trim() ? 'جرّب عبارة أخرى أو غيّر خيارات التصفية.' : 'أنشئ مسودة جديدة أو جرّب تغيير خيارات التصفية.'}</span><button type="button" className="text-button" onClick={openNewForm}>إنشاء أول سؤال <ArrowLeft size={15} /></button></div>}
          {!listQuery.isLoading && !listQuery.isError && items.length === 0 && pagination && pagination.total > 0 && <div className="instructor-state" data-testid="status-instructor-empty-page"><BookOpen size={24} /><strong>لا توجد أسئلة في هذه الصفحة</strong><button type="button" className="secondary-button" data-testid="button-instructor-return-to-previous-page" onClick={() => setPageOffset(Math.max(0, pageOffset - pagination.limit))}>العودة للصفحة السابقة</button></div>}
        {!listQuery.isLoading && !listQuery.isError && items.length > 0 && <div className="question-library">
          {items.map((question) => (
            <article className="question-library-row" key={question.id} data-testid={`row-instructor-question-${question.id}`}>
              <div className="question-row-main">
                <div className="question-row-meta">
                  <Pill tone={question.status === 'published' ? 'green' : question.status === 'archived' ? 'slate' : 'amber'}>{question.status === 'published' ? 'منشور' : question.status === 'archived' ? 'مؤرشف' : 'مسودة'}</Pill>
                  <span>{question.domain}</span><span>{question.approach}</span><span>{question.difficulty}</span>
                </div>
                <h3
                  id={`question-text-${question.id}`}
                  className={`question-row-question ${expandedQuestionIds.has(question.id) ? 'expanded' : ''}`}
                >
                  <HighlightedText text={question.question} query={filters.search} />
                </h3>
                <p><HighlightedText text={question.topic} query={filters.search} /></p>
                {question.question.length > 90 && (
                  <button
                    type="button"
                    className="question-expand-button"
                    aria-expanded={expandedQuestionIds.has(question.id)}
                    aria-controls={`question-text-${question.id}`}
                    data-testid={`button-expand-question-${question.id}`}
                    onClick={() => setExpandedQuestionIds((current) => {
                      const next = new Set(current);
                      if (next.has(question.id)) next.delete(question.id);
                      else next.add(question.id);
                      return next;
                    })}
                  >
                    <span>{expandedQuestionIds.has(question.id) ? 'إخفاء النص الكامل' : 'عرض نص السؤال كاملًا'}</span>
                    <ChevronDown className={expandedQuestionIds.has(question.id) ? 'expanded' : ''} size={14} aria-hidden="true" />
                  </button>
                )}
              </div>
              <div className="question-row-actions">
                <button type="button" className="table-action" data-testid={`button-edit-question-${question.id}`} onClick={() => openEditForm(question)}><Settings2 size={15} /> تعديل</button>
                <button type="button" className="table-action publish-action" disabled={isChangingStatus || question.status === 'published' || question.status === 'archived'} data-testid={`button-publish-question-${question.id}`} onClick={() => handleStatusChange(question, 'publish')}><Check size={15} /> {publishQuestion.isPending ? 'جارٍ…' : 'نشر'}</button>
                <button type="button" className="table-action archive-action" disabled={isChangingStatus || question.status === 'archived'} data-testid={`button-archive-question-${question.id}`} onClick={() => handleStatusChange(question, 'archive')}><ArchiveIcon /> {archiveQuestion.isPending ? 'جارٍ…' : 'أرشفة'}</button>
                {question.status === 'archived' && <button type="button" className="table-action" disabled={isChangingStatus} data-testid={`button-restore-question-${question.id}`} onClick={() => handleStatusChange(question, 'restore')}><RotateCcw size={15} /> {restoreQuestion.isPending ? 'جارٍ…' : 'استعادة كمسودة'}</button>}
              </div>
            </article>
          ))}
        </div>}
        {!listQuery.isLoading && !listQuery.isError && pagination && pagination.total > 0 && <div className="instructor-pagination" aria-label="التنقل بين صفحات بنك الأسئلة">
          <span>{pagination.offset + 1}–{Math.min(pagination.offset + items.length, pagination.total)} من {pagination.total}</span>
          <div>
            <button type="button" className="table-action" disabled={pagination.offset === 0 || listQuery.isFetching} onClick={() => setPageOffset(Math.max(0, pagination.offset - pagination.limit))}>
              <ArrowRight size={15} /> السابقة
            </button>
            <button type="button" className="table-action" disabled={!pagination.hasNext || pagination.nextOffset === null || listQuery.isFetching} onClick={() => { if (pagination.nextOffset !== null) setPageOffset(pagination.nextOffset); }}>
              التالية <ArrowLeft size={15} />
            </button>
          </div>
        </div>}
      </section>

      {currentRecoveredDraft && <div className="instructor-form-backdrop" role="presentation">
        <section className="recovery-dialog panel" data-testid="dialog-recovered-question-draft" role="dialog" aria-modal="true" aria-labelledby="recovered-draft-title">
          <div className="form-modal-heading">
            <div>
              <span className="card-kicker">Question recovery · استرداد المسودة</span>
              <h2 id="recovered-draft-title">وجدنا تعديلات غير محفوظة</h2>
            </div>
          </div>
          <p>يمكنك مراجعة العمل المحفوظ ومتابعة تعديله، أو حذفه قبل المتابعة.</p>
          <div className="recovered-draft-preview" data-testid="status-recovered-question-draft-preview">
            <strong>{currentRecoveredDraft.editingId ? 'تعديلات على سؤال موجود' : 'مسودة سؤال جديدة'}</strong>
            <span>الموضوع: {currentRecoveredDraft.form.topic || 'لم يحدد بعد'}</span>
            <p>{currentRecoveredDraft.form.question || 'لم يُكتب نص السؤال بعد'}</p>
            <small>آخر حفظ: {new Date(currentRecoveredDraft.updatedAt).toLocaleString()}</small>
          </div>
          <div className="form-modal-footer">
            <button type="button" className="secondary-button" data-testid="button-discard-question-draft" onClick={discardRecoveredDraft}>حذف المسودة</button>
            <button type="button" className="primary-button" data-testid="button-restore-question-draft" onClick={resumeRecoveredDraft}>مراجعة واستعادة التعديلات <ArrowLeft size={16} /></button>
          </div>
        </section>
      </div>}

      {formOpen && accountReady && <div className="instructor-form-backdrop" role="presentation">
        <section className="instructor-form panel" data-testid="dialog-question-form" role="dialog" aria-modal="true" aria-labelledby="question-form-title">
          <div className="form-modal-heading"><div><span className="card-kicker">Instructor authoring</span><h2 id="question-form-title">{editingId ? 'تعديل السؤال' : 'إنشاء مسودة سؤال'}</h2></div><button type="button" className="icon-button" aria-label="إغلاق النموذج" onClick={handleCloseForm}><X size={19} /></button></div>
          <div className="authoring-grid">
            <label>المجال<select data-testid="select-question-domain" value={form.domain} onChange={(event) => updateField('domain', event.target.value as InstructorFormState['domain'])}><option value="People">People</option><option value="Process">Process</option><option value="Business environment">Business environment</option></select></label>
            <label>الموضوع<input data-testid="input-question-topic" value={form.topic} onChange={(event) => updateField('topic', event.target.value)} placeholder="مثل: إدارة التغيير" /></label>
            <label>الأسلوب<select data-testid="select-question-approach" value={form.approach} onChange={(event) => updateField('approach', event.target.value as InstructorFormState['approach'])}><option value="agile">Agile</option><option value="predictive">Predictive</option><option value="hybrid">Hybrid</option></select></label>
            <label>الصعوبة<select data-testid="select-question-difficulty" value={form.difficulty} onChange={(event) => updateField('difficulty', event.target.value as InstructorFormState['difficulty'])}><option value="easy">سهل</option><option value="medium">متوسط</option><option value="hard">صعب</option></select></label>
          </div>
          <label className="authoring-wide">نص السؤال<input data-testid="input-question-text" value={form.question} onChange={(event) => updateField('question', event.target.value)} placeholder="اكتب سيناريو واقعيًا ومحددًا…" /></label>
          <label className="authoring-wide">الترجمة العربية<textarea data-testid="textarea-question-translation" value={form.translation} onChange={(event) => updateField('translation', event.target.value)} rows={2} placeholder="الترجمة العربية للسؤال" /></label>
          <div className="options-editor"><span className="field-label">خيارات الإجابة <small>حدد الخيار الصحيح</small></span>{form.options.map((option, index) => <label className={`answer-editor ${form.correctAnswer === index ? 'correct-answer' : ''}`} key={index}><input type="radio" name="correctAnswer" checked={form.correctAnswer === index} onChange={() => updateField('correctAnswer', index)} aria-label={`تحديد الخيار ${index + 1} كإجابة صحيحة`} /><span className="answer-index">{String.fromCharCode(65 + index)}</span><input data-testid={`input-question-option-${index}`} value={option} onChange={(event) => setForm((current) => ({ ...current, options: current.options.map((item, itemIndex) => itemIndex === index ? event.target.value : item) as InstructorFormState['options'] }))} placeholder={`الخيار ${index + 1}`} /></label>)}</div>
          <label className="authoring-wide">التفسير<textarea data-testid="textarea-question-explanation" value={form.explanation} onChange={(event) => updateField('explanation', event.target.value)} rows={3} placeholder="اشرح لماذا هذه الإجابة هي الأفضل…" /></label>
          {validationError && <div className="form-error" data-testid="status-question-validation" role="alert" aria-live="polite"><X size={15} /> {validationError}</div>}
          {(createQuestion.isError || updateQuestion.isError) && <div className="form-error" data-testid="status-question-save-error" role="alert" aria-live="polite"><X size={15} /> {errorMessage(createQuestion.error ?? updateQuestion.error)}</div>}
          <div className="form-modal-footer"><span>سيُحفظ السؤال كمسودة.</span><div><button type="button" className="secondary-button" onClick={handleCloseForm}>إلغاء</button><button type="button" className="primary-button" disabled={isSaving} data-testid="button-save-question" onClick={handleSave}>{isSaving ? 'جارٍ الحفظ…' : 'حفظ المسودة'} <ArrowLeft size={16} /></button></div></div>
        </section>
      </div>}
    </div>
  );
}

function ArchiveIcon() {
  return <span className="archive-icon" aria-hidden="true">↘</span>;
}

function ArrowUpIcon() {
  return <span className="arrow-up">↗</span>;
}

function mapApiQuestion(question: Question): PmpQuestion {
  return {
    id: question.id,
    domain: question.domain,
    topic: question.topic,
    approach: question.approach,
    question: question.question,
    translation: question.translation,
    options: question.options,
    correct: question.correctAnswer,
    explanation: question.explanation,
  };
}

function mapSavedSession(session: PracticeSession) {
  return {
    questions: session.questions.map(mapApiQuestion),
    answers: session.answers.map((answer) => ({
      questionId: answer.questionId,
      selected: answer.selectedAnswer,
    })),
  };
}

const emptyProgress: DashboardProgress = {
  readinessScore: 0,
  questionCount: 0,
  completedSessions: 0,
  averageScore: 0,
  studyMinutes: 0,
  lastScore: null,
  recentActivity: [],
};

function PracticeUnavailable({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <div className="page-wrap practice-state-page">
      <div className="practice-state panel">
        {loading ? <><div className="state-icon loading-icon"><span /></div><h1>نحمّل أسئلتك المنشورة…</h1><p>لحظات ونجهّز جلسة هادئة للتركيز.</p></> : <><div className="state-icon"><X size={21} /></div><h1>لم نتمكن من بدء الجلسة</h1><p>{errorMessage(error)}</p><button type="button" className="secondary-button" onClick={onRetry}>إعادة المحاولة</button></>}
      </div>
    </div>
  );
}

function SessionDetailState({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <div className="page-wrap practice-state-page">
      <div className="practice-state panel" data-testid={loading ? 'status-session-detail-loading' : 'status-session-detail-error'}>
        {loading ? (
          <>
            <div className="state-icon loading-icon"><span /></div>
            <h1>جارٍ استعادة نتيجة الجلسة…</h1>
            <p>نحضر إجاباتك المحفوظة ومراجعة الأخطاء.</p>
          </>
        ) : (
          <>
            <div className="state-icon"><X size={21} /></div>
            <h1>تعذر فتح هذه الجلسة</h1>
            <p>{errorMessage(error)}</p>
            <button type="button" className="secondary-button" data-testid="button-retry-session-detail" onClick={onRetry}>إعادة المحاولة</button>
          </>
        )}
      </div>
    </div>
  );
}

function App() {
  const [page, setPage] = useState<Page>(getInitialPage);
  const queryClient = useQueryClient();
  const auth = useAuth();
  const [language, setLanguage] = useState<Language>('ar');
  const [anonymousLearnerId] = useState(getLearnerId);
  const learnerId = auth.user?.id ?? anonymousLearnerId;
  const learnerRequest = useMemo(() => ({ headers: { 'x-learner-id': learnerId } }), [learnerId]);
  const [settings, setSettings] = useState({
    mode: 'quick' as PracticeMode,
    domain: 'all',
    approach: 'all' as Approach,
    count: 10,
    timed: true,
  });
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedChoice, setSelectedChoice] = useState<number | null>(null);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [remainingSeconds, setRemainingSeconds] = useState(600);
  const [lastScore, setLastScore] = useState<number | null>(null);
  const [lastCompletionReason, setLastCompletionReason] = useState<PracticeSession['completionReason']>('manual');
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [activeSessionQuestions, setActiveSessionQuestions] = useState<PmpQuestion[]>([]);
  const [bookmarkedQuestionIds, setBookmarkedQuestionIds] = useState<string[]>([]);
  const [bookmarkRemovalErrors, setBookmarkRemovalErrors] = useState<Set<string>>(() => new Set());
  const [practiceBookmarkErrors, setPracticeBookmarkErrors] = useState<Set<string>>(() => new Set());
  const [sessionMutationError, setSessionMutationError] = useState<unknown>(null);
  const [dashboardAbandoningSessionId, setDashboardAbandoningSessionId] = useState<string | null>(null);
  const [dashboardAbandonFailed, setDashboardAbandonFailed] = useState(false);
  const [expiryError, setExpiryError] = useState<unknown>(null);

  useEffect(() => {
    if (!auth.isLoading) {
      queryClient.clear();
      setBookmarkRemovalErrors(new Set());
      setPracticeBookmarkErrors(new Set());
    }
  }, [auth.isLoading, auth.user?.id, queryClient]);

  useEffect(() => {
    if (!auth.isLoading && page === 'admin' && auth.user?.role !== 'admin') {
      setPage('dashboard');
    }
  }, [auth.isLoading, auth.user?.role, page]);

  const publishedFilters = useMemo<ListPublishedQuestionsParams>(() => ({
    ...(settings.domain === 'all' ? {} : { domain: settings.domain as ListPublishedQuestionsParams['domain'] }),
    ...(settings.approach === 'all' ? {} : { approach: settings.approach }),
  }), [settings.domain, settings.approach]);
  const publishedQuery = useListPublishedQuestions(publishedFilters);
  const progressQuery = useGetDashboardProgress({ request: learnerRequest });
  const latestSessionQuery = useGetLatestPracticeSession({
    request: learnerRequest,
    query: { queryKey: ['latest-practice-session', learnerId], retry: false },
  });
  const inProgressSessionQuery = useGetInProgressPracticeSession({
    request: learnerRequest,
    query: { queryKey: ['in-progress-practice-session', learnerId], retry: false },
  });
  const bookmarksQuery = useListBookmarks({ request: learnerRequest });
  const selectedSessionQuery = useGetPracticeSession(selectedSessionId ?? '', {
    request: learnerRequest,
    query: {
      enabled: Boolean(selectedSessionId),
      queryKey: getGetPracticeSessionQueryKey(selectedSessionId ?? ''),
      retry: false,
    },
  });
  const createSession = useCreatePracticeSession({ request: learnerRequest });
  const saveAnswer = useSavePracticeAnswer({ request: learnerRequest });
  const completeSession = useCompletePracticeSession({ request: learnerRequest });
  const abandonSession = useAbandonPracticeSession({ request: learnerRequest });
  const updateBookmark = useUpdateBookmark({ request: learnerRequest });
  const addResumableSession = (session: PracticeSession) => {
    queryClient.setQueryData<PracticeSession[]>(
      ['in-progress-practice-session', learnerId],
      (current) => [
        session,
        ...(current ?? []).filter((item) => item.id !== session.id),
      ],
    );
  };
  const removeResumableSession = (sessionId: string) => {
    queryClient.setQueryData<PracticeSession[]>(
      ['in-progress-practice-session', learnerId],
      (current) => (current ?? []).filter((session) => session.id !== sessionId),
    );
  };
  const sessionQuestions = useMemo(() => {
    return (publishedQuery.data ?? []).map(mapApiQuestion).slice(0, settings.count);
  }, [publishedQuery.data, settings.count]);

  const hydrateSession = (session: PracticeSession) => {
    const mapped = mapSavedSession(session);
    const answerByQuestionId = new Map(mapped.answers.map((answer) => [answer.questionId, answer]));
    const firstUnansweredIndex = mapped.questions.findIndex(
      (question) => !answerByQuestionId.has(question.id),
    );
    const nextIndex = firstUnansweredIndex === -1
      ? Math.max(0, mapped.questions.length - 1)
      : Math.max(0, firstUnansweredIndex);
    const currentQuestion = mapped.questions[nextIndex];
    const currentAnswer = currentQuestion
      ? answerByQuestionId.get(currentQuestion.id)
      : undefined;

    setActiveSessionId(session.id);
    setActiveSessionQuestions(mapped.questions);
    setAnswers(mapped.answers);
    setLastScore(session.score);
    setLastCompletionReason(session.completionReason);
    setCurrentIndex(nextIndex);
    setSelectedChoice(currentAnswer?.selected ?? null);
    setRemainingSeconds(
      session.timed
        ? Math.max(
            0,
            session.questionIds.length * 60 -
              Math.floor((Date.now() - new Date(session.startedAt).getTime()) / 1000),
          )
        : 0,
    );
    setSettings((current) => ({
      ...current,
      mode: session.mode,
      domain: session.domain ?? 'all',
      approach: (session.approach ?? 'all') as Approach,
      timed: session.timed,
      count: session.questionIds.length,
    }));
  };

  useEffect(() => {
    const newestSession = inProgressSessionQuery.data?.[0];
    if (newestSession && page === 'session') hydrateSession(newestSession);
  }, [inProgressSessionQuery.data]);

  useEffect(() => {
    if (selectedSessionQuery.data && selectedSessionQuery.data.id === selectedSessionId) {
      hydrateSession(selectedSessionQuery.data);
    }
  }, [selectedSessionQuery.data, selectedSessionId]);

  useEffect(() => {
    if (
      latestSessionQuery.data &&
      (inProgressSessionQuery.data?.length ?? 0) === 0 &&
      !selectedSessionId &&
      page !== 'session'
    ) {
      hydrateSession(latestSessionQuery.data);
    }
  }, [latestSessionQuery.data, inProgressSessionQuery.data, page, selectedSessionId]);

  useEffect(() => {
    if (bookmarksQuery.data) setBookmarkedQuestionIds(bookmarksQuery.data);
  }, [bookmarksQuery.data]);

  const startSession = async () => {
    if (publishedQuery.isLoading || publishedQuery.isError || sessionQuestions.length === 0) return;
    setSessionMutationError(null);
    try {
      const session = await createSession.mutateAsync({
        data: {
          mode: settings.mode,
          domain: settings.domain === 'all' ? null : settings.domain,
          approach: settings.approach === 'all' ? null : settings.approach,
          timed: settings.timed,
          questionIds: sessionQuestions.map((question) => question.id),
        },
      });
      addResumableSession(session);
      setSelectedSessionId(null);
      setActiveSessionId(session.id);
      setActiveSessionQuestions(sessionQuestions);
      setAnswers([]);
      setLastScore(null);
      setLastCompletionReason('manual');
      setExpiryError(null);
      setCurrentIndex(0);
      setSelectedChoice(null);
      setRemainingSeconds(session.questionIds.length * 60);
      setPage('session');
    } catch (error) {
      setSessionMutationError(error);
    }
  };

  const startSavedReview = async (questionIds: string[]) => {
    if (questionIds.length === 0 || createSession.isPending) return;
    setSessionMutationError(null);
    try {
      const session = await createSession.mutateAsync({
        data: {
          mode: 'quick',
          domain: null,
          approach: null,
          timed: false,
          questionIds,
        },
      });
      addResumableSession(session);
      setSelectedSessionId(null);
      hydrateSession(session);
      setPage('session');
    } catch (error) {
      setSessionMutationError(error);
    }
  };

  const nextQuestion = async () => {
    if (selectedChoice === null) return;
    const currentQuestion = activeSessionQuestions[currentIndex];
    if (!currentQuestion || !activeSessionId) return;
    const newAnswers = [
      ...answers.filter((answer) => answer.questionId !== currentQuestion.id),
      { questionId: currentQuestion.id, selected: selectedChoice },
    ];
    setAnswers(newAnswers);
    try {
      await saveAnswer.mutateAsync({
        id: activeSessionId,
        data: { questionId: currentQuestion.id, selectedAnswer: selectedChoice },
      });
      if (currentIndex === activeSessionQuestions.length - 1) {
        const completed = await completeSession.mutateAsync({ id: activeSessionId });
        hydrateSession(completed);
        setLastScore(completed.score);
        removeResumableSession(completed.id);
        void progressQuery.refetch();
        void latestSessionQuery.refetch();
        void inProgressSessionQuery.refetch();
        void queryClient.invalidateQueries({ queryKey: getListPracticeSessionsQueryKey() });
        setPage('results');
        return;
      }
      setCurrentIndex((index) => index + 1);
      setSelectedChoice(null);
    } catch (error) {
      setSessionMutationError(error);
    }
  };

  const continueSession = (sessionId: string) => {
    const session = inProgressSessionQuery.data?.find((item) => item.id === sessionId);
    if (!session) return;
    setSelectedSessionId(null);
    hydrateSession(session);
    setPage('session');
  };

  const completeExpiredSession = async () => {
    if (!activeSessionId || completeSession.isPending) return;
    const currentQuestion = activeSessionQuestions[currentIndex];
    const currentAnswer = selectedChoice === null || !currentQuestion
      ? null
      : { questionId: currentQuestion.id, selected: selectedChoice };
    const newAnswers = currentAnswer
      ? [
          ...answers.filter((answer) => answer.questionId !== currentAnswer.questionId),
          currentAnswer,
        ]
      : answers;

    setAnswers(newAnswers);
    setExpiryError(null);
    try {
      if (currentAnswer) {
        await saveAnswer.mutateAsync({
          id: activeSessionId,
          data: {
            questionId: currentAnswer.questionId,
            selectedAnswer: currentAnswer.selected,
          },
        });
      }
      const completed = await completeSession.mutateAsync({ id: activeSessionId });
      hydrateSession(completed);
      setLastScore(completed.score);
      removeResumableSession(activeSessionId);
      void progressQuery.refetch();
      void latestSessionQuery.refetch();
      void inProgressSessionQuery.refetch();
      void queryClient.invalidateQueries({ queryKey: getListPracticeSessionsQueryKey() });
      setPage('results');
    } catch (error) {
      setExpiryError(error);
    }
  };

  const abandonActiveSession = async () => {
    if (!activeSessionId || abandonSession.isPending) return;
    if (!window.confirm('هل تريد إنهاء هذه الجلسة؟ ستظل الإجابات محفوظة ولن تظهر كجلسة قيد التقدم.')) {
      return;
    }

    setSessionMutationError(null);
    try {
      await abandonSession.mutateAsync({ id: activeSessionId });
      setActiveSessionId(null);
      setActiveSessionQuestions([]);
      setAnswers([]);
      setCurrentIndex(0);
      setSelectedChoice(null);
      setLastScore(null);
      setExpiryError(null);
      removeResumableSession(activeSessionId);
      setDashboardAbandonFailed(false);
      await inProgressSessionQuery.refetch();
      setPage('dashboard');
    } catch (error) {
      setSessionMutationError(error);
    }
  };

  const abandonDashboardSession = async (sessionId: string) => {
    if (
      dashboardAbandoningSessionId !== null ||
      abandonSession.isPending ||
      !inProgressSessionQuery.data?.some((session) => session.id === sessionId)
    ) {
      return;
    }
    if (!window.confirm('هل تريد التخلي عن هذه الجلسة؟ ستظل إجاباتك محفوظة، ولن تظهر كجلسة غير مكتملة.')) {
      return;
    }

    setDashboardAbandonFailed(false);
    setDashboardAbandoningSessionId(sessionId);
    try {
      await abandonSession.mutateAsync({ id: sessionId });
      removeResumableSession(sessionId);
      void inProgressSessionQuery.refetch();
    } catch {
      setDashboardAbandonFailed(true);
    } finally {
      setDashboardAbandoningSessionId(null);
    }
  };

  const toggleBookmark = (questionId: string, duringPractice = false) => {
    const saved = bookmarkedQuestionIds.includes(questionId);
    if (duringPractice) {
      setPracticeBookmarkErrors((current) => {
        if (!current.has(questionId)) return current;
        const next = new Set(current);
        next.delete(questionId);
        return next;
      });
    }
    updateBookmark.mutate(
      { questionId, data: { saved: !saved } },
      {
        onSuccess: () => {
          setBookmarkedQuestionIds((current) =>
            saved ? current.filter((id) => id !== questionId) : [...current, questionId],
          );
          setPracticeBookmarkErrors((current) => {
            if (!current.has(questionId)) return current;
            const next = new Set(current);
            next.delete(questionId);
            return next;
          });
          if (saved) {
            setBookmarkRemovalErrors((current) => {
              const next = new Set(current);
              next.delete(questionId);
              return next;
            });
          }
          void queryClient.invalidateQueries({ queryKey: getListBookmarksQueryKey() });
          void queryClient.invalidateQueries({ queryKey: getListBookmarkQuestionsQueryKey() });
        },
        onError: () => {
          if (duringPractice) {
            setPracticeBookmarkErrors((current) => new Set(current).add(questionId));
          }
          if (saved) {
            setBookmarkRemovalErrors((current) => new Set(current).add(questionId));
          }
        },
      },
    );
  };

  const openSavedSession = (sessionId: string) => {
    setSessionMutationError(null);
    setSelectedSessionId(sessionId);
    setPage('results');
  };

  const visibleSessionQuestions = activeSessionQuestions.length > 0
    ? activeSessionQuestions
    : sessionQuestions;
  const isSelectedSessionLoading = Boolean(selectedSessionId) && selectedSessionQuery.isLoading;
  const isSelectedSessionError = Boolean(selectedSessionId) && selectedSessionQuery.isError;

  useEffect(() => {
    if (page !== 'session' || !settings.timed || remainingSeconds <= 0) return;
    const interval = window.setInterval(() => {
      setRemainingSeconds((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [page, settings.timed, remainingSeconds]);

  useEffect(() => {
    if (page !== 'session' || !settings.timed || remainingSeconds !== 0) return;
    void completeExpiredSession();
  }, [page, settings.timed, remainingSeconds, activeSessionId, selectedChoice, currentIndex]);

  useEffect(() => {
    document.documentElement.lang = language === 'ar' ? 'ar' : 'en';
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
  }, [language]);

  useEffect(() => {
    window.localStorage.setItem('pmp-sprint-page', page);
  }, [page]);

  return (
    <AppShell page={page} setPage={setPage} language={language} setLanguage={setLanguage} auth={auth}>
      {page === 'dashboard' && <Dashboard
        setPage={setPage}
        progress={progressQuery.data ?? emptyProgress}
        onOpenSession={openSavedSession}
        inProgressSessions={inProgressSessionQuery.data ?? []}
        onContinueSession={continueSession}
        onAbandonSession={(sessionId) => void abandonDashboardSession(sessionId)}
        abandoningSessionId={dashboardAbandoningSessionId}
        abandonError={dashboardAbandonFailed}
      />}
      {page === 'setup' && <Setup settings={settings} setSettings={setSettings} onStart={startSession} availableQuestions={publishedQuery.data?.length ?? 0} isLoading={publishedQuery.isLoading} isError={publishedQuery.isError} onRetry={() => void publishedQuery.refetch()} />}
      {page === 'library' && (
        <LibraryPage
          learnerRequest={learnerRequest}
          onStartReview={startSavedReview}
          onToggleBookmark={toggleBookmark}
          isUpdatingBookmark={updateBookmark.isPending}
          bookmarkRemovalErrors={bookmarkRemovalErrors}
          onStartPractice={() => setPage('setup')}
        />
      )}
      {page === 'reports' && (
        <ReportsPage
          learnerRequest={learnerRequest}
          onOpenSession={openSavedSession}
          onStartPractice={() => setPage('setup')}
        />
      )}
      {page === 'session' && (
        visibleSessionQuestions.length > 0 && visibleSessionQuestions[currentIndex] ? <Session
          settings={settings}
          question={visibleSessionQuestions[currentIndex]}
          questionNumber={currentIndex + 1}
          total={visibleSessionQuestions.length}
          selectedChoice={selectedChoice}
          setSelectedChoice={setSelectedChoice}
          onNext={nextQuestion}
          onAbandon={() => void abandonActiveSession()}
          isAbandoning={abandonSession.isPending}
          isBookmarked={bookmarkedQuestionIds.includes(visibleSessionQuestions[currentIndex].id)}
          isUpdatingBookmark={updateBookmark.isPending}
          bookmarkUpdateFailed={practiceBookmarkErrors.has(visibleSessionQuestions[currentIndex].id)}
          onToggleBookmark={() => toggleBookmark(visibleSessionQuestions[currentIndex].id, true)}
          remainingSeconds={remainingSeconds}
          isCompleting={saveAnswer.isPending || completeSession.isPending}
          expiryError={expiryError}
          onRetryCompletion={() => void completeExpiredSession()}
        /> : <PracticeUnavailable loading={publishedQuery.isLoading} error={publishedQuery.error} onRetry={() => void publishedQuery.refetch()} />
      )}
      {page === 'results' && (isSelectedSessionLoading || isSelectedSessionError ? (
        <SessionDetailState
          loading={isSelectedSessionLoading}
          error={selectedSessionQuery.error}
          onRetry={() => void selectedSessionQuery.refetch()}
        />
      ) : <Results answers={answers} sessionQuestions={visibleSessionQuestions} sessionScore={lastScore} completionReason={lastCompletionReason} setPage={setPage} />)}
      {page === 'review' && (isSelectedSessionLoading || isSelectedSessionError ? (
        <SessionDetailState
          loading={isSelectedSessionLoading}
          error={selectedSessionQuery.error}
          onRetry={() => void selectedSessionQuery.refetch()}
        />
      ) : <Review answers={answers} sessionQuestions={visibleSessionQuestions} completionReason={lastCompletionReason} setPage={setPage} />)}
      {page === 'instructor' && <InstructorWorkspace
        onBack={() => setPage('setup')}
        accountId={auth.user?.id ?? null}
        canAccess={auth.user?.role === 'instructor'}
      />}
      {page === 'admin' && auth.user?.role === 'admin' && <AdminAccessPage />}
      {Boolean(sessionMutationError) && page === 'setup' && <div className="feedback form-error">{errorMessage(sessionMutationError)}</div>}
    </AppShell>
  );
}

export default function RootApp() {
  return <App />;
}