import {
  Bookmark,
  BookOpen,
  CalendarDays,
  ChevronLeft,
  Clock3,
  FileQuestion,
  History,
  RefreshCw,
  Search,
  Target,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  getListBookmarkQuestionsQueryKey,
  getListPracticeSessionsQueryKey,
  useListBookmarkQuestions,
  useListPracticeSessions,
} from '@workspace/api-client-react';
import type { PracticeSessionSummary, Question } from '@workspace/api-client-react';

type LearnerRequest = {
  headers: {
    'x-learner-id': string;
  };
};

const modeLabels: Record<PracticeSessionSummary['mode'], string> = {
  quick: 'تدريب سريع',
  domain: 'تركيز حسب المجال',
  mock: 'اختبار تجريبي',
};

function formatSessionDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'تاريخ غير متاح';
  return date.toLocaleDateString('ar-EG', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function normalizeLibrarySearchText(value: string) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '');
}

type LibraryFilters = {
  searchTerm: string;
  domainFilter: Question['domain'] | 'all';
  difficultyFilter: Question['difficulty'] | 'all';
};

const emptyLibraryFilters: LibraryFilters = {
  searchTerm: '',
  domainFilter: 'all',
  difficultyFilter: 'all',
};

function getLibraryFiltersStorageKey(learnerId: string) {
  return `pmp-question-bank:library-filters:${encodeURIComponent(learnerId)}`;
}

function readLibraryFilters(learnerId: string): LibraryFilters {
  if (!learnerId || typeof window === 'undefined') return { ...emptyLibraryFilters };

  try {
    const savedFilters = window.localStorage.getItem(getLibraryFiltersStorageKey(learnerId));
    if (!savedFilters) return { ...emptyLibraryFilters };
    const parsed: unknown = JSON.parse(savedFilters);
    if (typeof parsed !== 'object' || parsed === null) return { ...emptyLibraryFilters };

    const filters = parsed as Partial<LibraryFilters>;
    const domains: Array<LibraryFilters['domainFilter']> = [
      'all',
      'People',
      'Process',
      'Business environment',
    ];
    const difficulties: Array<LibraryFilters['difficultyFilter']> = [
      'all',
      'easy',
      'medium',
      'hard',
    ];

    return {
      searchTerm: typeof filters.searchTerm === 'string' ? filters.searchTerm : '',
      domainFilter: domains.includes(filters.domainFilter as LibraryFilters['domainFilter'])
        ? filters.domainFilter as LibraryFilters['domainFilter']
        : 'all',
      difficultyFilter: difficulties.includes(filters.difficultyFilter as LibraryFilters['difficultyFilter'])
        ? filters.difficultyFilter as LibraryFilters['difficultyFilter']
        : 'all',
    };
  } catch {
    return { ...emptyLibraryFilters };
  }
}

function HistorySkeleton({ label }: { label: string }) {
  return (
    <div className="history-state" data-testid={`status-${label}-loading`}>
      <div className="history-skeleton" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <strong>جارٍ تحميل {label === 'library' ? 'مكتبتك' : 'جلساتك'}…</strong>
      <span>نحضر سجل تعلمك المحفوظ.</span>
    </div>
  );
}

function HistoryError({
  label,
  onRetry,
}: {
  label: 'library' | 'reports';
  onRetry: () => void;
}) {
  return (
    <div className="history-state history-error" data-testid={`status-${label}-error`}>
      <div className="history-state-icon"><X size={20} /></div>
      <strong>تعذر تحميل {label === 'library' ? 'المكتبة' : 'التقارير'}</strong>
      <span>تحقق من الاتصال ثم حاول مرة أخرى. بياناتك المحفوظة لم تتغير.</span>
      <button type="button" className="secondary-button" data-testid={`button-retry-${label}`} onClick={onRetry}>
        <RefreshCw size={15} /> إعادة المحاولة
      </button>
    </div>
  );
}

function HistoryEmpty({
  label,
  onAction,
}: {
  label: 'library' | 'reports';
  onAction: () => void;
}) {
  const library = label === 'library';
  return (
    <div className="history-state history-empty" data-testid={`status-${label}-empty`}>
      <div className="history-state-icon">{library ? <Bookmark size={21} /> : <History size={21} />}</div>
      <strong>{library ? 'مكتبتك هادئة الآن' : 'لا توجد جلسات مكتملة بعد'}</strong>
      <span>{library ? 'احفظ سؤالًا أثناء التدريب ليبقى قريبًا منك للمراجعة.' : 'أكمل جلسة تدريب واحدة لتبدأ رحلتك في التقارير.'}</span>
      <button type="button" className="secondary-button" data-testid={`button-empty-${label}-action`} onClick={onAction}>
        {library ? <Target size={15} /> : <FileQuestion size={15} />}
        {library ? 'ابدأ تدريبًا واحفظ سؤالًا' : 'ابدأ جلسة تدريب'}
      </button>
    </div>
  );
}

type LibraryPageProps = {
  learnerRequest: LearnerRequest;
  onStartReview: (questionIds: string[]) => void;
  onToggleBookmark: (questionId: string) => void;
  isUpdatingBookmark: boolean;
  bookmarkRemovalErrors: Set<string>;
  onStartPractice: () => void;
};

export function LibraryPage(props: LibraryPageProps) {
  const learnerId = props.learnerRequest.headers['x-learner-id'];
  return <LearnerLibraryPage key={learnerId} {...props} />;
}

function LearnerLibraryPage({
  learnerRequest,
  onStartReview,
  onToggleBookmark,
  isUpdatingBookmark,
  bookmarkRemovalErrors,
  onStartPractice,
}: LibraryPageProps) {
  const learnerId = learnerRequest.headers['x-learner-id'];
  const [filters, setFilters] = useState<LibraryFilters>(() => readLibraryFilters(learnerId));
  const { searchTerm, domainFilter, difficultyFilter } = filters;
  const storageKey = getLibraryFiltersStorageKey(learnerId);
  useEffect(() => {
    try {
      if (searchTerm === '' && domainFilter === 'all' && difficultyFilter === 'all') {
        window.localStorage.removeItem(storageKey);
      } else {
        window.localStorage.setItem(
          storageKey,
          JSON.stringify({ searchTerm, domainFilter, difficultyFilter }),
        );
      }
    } catch {
      // Keep the library usable when browser storage is unavailable.
    }
  }, [storageKey, searchTerm, domainFilter, difficultyFilter]);

  const query = useListBookmarkQuestions({
    request: learnerRequest,
    query: {
      queryKey: getListBookmarkQuestionsQueryKey(),
      retry: false,
    },
  });
  const questions = query.data ?? [];
  const normalizedSearchTerm = normalizeLibrarySearchText(searchTerm.trim());
  const hasActiveLibraryFilters = Boolean(
    normalizedSearchTerm || domainFilter !== 'all' || difficultyFilter !== 'all',
  );
  const filteredQuestions = questions.filter((question) => {
    const matchesSearch = !normalizedSearchTerm
      || normalizeLibrarySearchText(question.topic).includes(normalizedSearchTerm)
      || normalizeLibrarySearchText(question.question).includes(normalizedSearchTerm)
      || normalizeLibrarySearchText(question.translation).includes(normalizedSearchTerm);
    return matchesSearch
      && (domainFilter === 'all' || question.domain === domainFilter)
      && (difficultyFilter === 'all' || question.difficulty === difficultyFilter);
  });
  const reviewableQuestions = questions.filter((question) => question.status === 'published');
  const clearLibraryFilters = () => {
    setFilters({ ...emptyLibraryFilters });
  };

  return (
    <div className="page-wrap library-page">
      <section className="page-heading">
        <div>
          <div className="eyebrow">Saved questions · مكتبتي</div>
          <h1>أسئلتك المهمة، في مكان واحد.</h1>
          <p>عد إلى الأسئلة التي أردت أن تفكر فيها مرة أخرى، وابدأ مراجعة مركّزة متى احتجت.</p>
        </div>
        <button
          type="button"
          className="primary-button"
          data-testid="button-start-library-review"
          disabled={reviewableQuestions.length === 0 || query.isLoading}
          onClick={() => onStartReview(reviewableQuestions.map((question) => question.id))}
        >
          <RefreshCw size={16} /> راجع المحفوظة
        </button>
      </section>

      <section className="library-intro panel">
        <div className="library-intro-icon"><BookOpen size={20} /></div>
        <div>
          <span className="card-kicker">مراجعة عند الحاجة · Review when ready</span>
          <h2>لا تفقد الأسئلة التي تستحق وقتك.</h2>
          <p>المحفوظات تبقى مرتبطة بحسابك، حتى بعد أن تنهي جلسة أو تبدأ واحدة جديدة.</p>
        </div>
        <div className="library-count" data-testid="text-library-count">
          <strong>{query.isLoading || query.isError ? '—' : questions.length}</strong>
          <span>سؤال محفوظ</span>
        </div>
      </section>

      <section className="panel library-list-panel">
        <div className="panel-heading">
          <div>
            <span className="card-kicker">Your collection</span>
            <h2>الأسئلة المحفوظة</h2>
          </div>
          {questions.length > 0 && <span className="history-result-count">{questions.length} محفوظة</span>}
        </div>
        {!query.isLoading && !query.isError && questions.length > 0 && (
          <div className="library-search-toolbar">
            <label className="library-search-field">
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                data-testid="input-library-search"
                aria-label="ابحث حسب الموضوع أو نص السؤال"
                placeholder="ابحث حسب الموضوع أو نص السؤال"
                value={searchTerm}
                onChange={(event) => setFilters((current) => ({ ...current, searchTerm: event.target.value }))}
              />
            </label>
            <label className="library-filter-select">
              <span>المجال</span>
              <select
                data-testid="select-library-domain"
                aria-label="تصفية حسب المجال"
                value={domainFilter}
                onChange={(event) => setFilters((current) => ({ ...current, domainFilter: event.target.value as typeof domainFilter }))}
              >
                <option value="all">كل المجالات</option>
                <option value="People">People</option>
                <option value="Process">Process</option>
                <option value="Business environment">Business environment</option>
              </select>
            </label>
            <label className="library-filter-select">
              <span>الصعوبة</span>
              <select
                data-testid="select-library-difficulty"
                aria-label="تصفية حسب الصعوبة"
                value={difficultyFilter}
                onChange={(event) => setFilters((current) => ({ ...current, difficultyFilter: event.target.value as typeof difficultyFilter }))}
              >
                <option value="all">كل المستويات</option>
                <option value="easy">سهل</option>
                <option value="medium">متوسط</option>
                <option value="hard">صعب</option>
              </select>
            </label>
            {searchTerm && (
              <button
                type="button"
                className="library-search-clear"
                data-testid="button-clear-library-search"
                aria-label="مسح البحث"
                onClick={() => setFilters((current) => ({ ...current, searchTerm: '' }))}
              >
                <X size={15} />
              </button>
            )}
            {hasActiveLibraryFilters && (
              <button
                type="button"
                className="library-filters-reset"
                data-testid="button-reset-library-filters"
                onClick={clearLibraryFilters}
              >
                مسح الفلاتر
              </button>
            )}
            <span className="library-search-count" data-testid="text-library-search-results" aria-live="polite">
              {filteredQuestions.length} من {questions.length} سؤال
            </span>
          </div>
        )}
        {!query.isLoading && !query.isError && questions.length > 0 && reviewableQuestions.length === 0 && (
          <div className="library-notice" data-testid="status-library-no-reviewable">
            <Clock3 size={15} />
            <span>الأسئلة المحفوظة هنا مؤرشفة حاليًا، لذلك لا يمكن بدء جلسة مراجعة جديدة منها.</span>
          </div>
        )}

        {query.isLoading ? <HistorySkeleton label="library" /> : null}
        {query.isError ? <HistoryError label="library" onRetry={() => void query.refetch()} /> : null}
        {!query.isLoading && !query.isError && questions.length === 0 ? (
          <HistoryEmpty label="library" onAction={onStartPractice} />
        ) : null}
        {!query.isLoading && !query.isError && questions.length > 0 && filteredQuestions.length === 0 ? (
          <div className="history-state history-search-empty" data-testid="status-library-no-results">
            <div className="history-state-icon"><Search size={20} /></div>
            <strong>لا توجد أسئلة تطابق البحث والفلاتر</strong>
            <span>غيّر البحث أو الفلاتر لعرض أسئلة أخرى من مكتبتك.</span>
            <button type="button" className="secondary-button" onClick={clearLibraryFilters}>
              مسح البحث والفلاتر
            </button>
          </div>
        ) : null}
        {!query.isLoading && !query.isError && filteredQuestions.length > 0 ? (
          <div className="saved-question-list">
            {filteredQuestions.map((question) => (
              <SavedQuestionRow
                key={question.id}
                question={question}
                onRemove={() => onToggleBookmark(question.id)}
                isUpdating={isUpdatingBookmark}
                isRemovalFailed={bookmarkRemovalErrors.has(question.id)}
              />
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function SavedQuestionRow({
  question,
  onRemove,
  isUpdating,
  isRemovalFailed,
}: {
  question: Question;
  onRemove: () => void;
  isUpdating: boolean;
  isRemovalFailed: boolean;
}) {
  return (
    <article className="saved-question-row" data-testid={`card-saved-question-${question.id}`}>
      <div className="saved-question-index"><Bookmark size={16} fill="currentColor" /></div>
      <div className="saved-question-copy">
        <div className="saved-question-meta">
          <span>{question.domain}</span>
          <span>{question.topic}</span>
          <span>{question.approach}</span>
        </div>
        <h3 data-testid={`text-saved-question-${question.id}`}>{question.question}</h3>
        <p>{question.translation}</p>
        <div className="saved-question-footer">
          <span>{question.options.length} خيارات · {question.difficulty === 'hard' ? 'صعب' : question.difficulty === 'easy' ? 'سهل' : 'متوسط'}</span>
          <span className="saved-question-date">حُفظ ضمن مكتبتك</span>
        </div>
        {isRemovalFailed && (
          <div
            className="saved-question-error"
            role="alert"
            data-testid={`status-bookmark-removal-error-${question.id}`}
          >
            تعذر إزالة السؤال. ما زال محفوظًا؛ يمكنك المحاولة مرة أخرى.
          </div>
        )}
      </div>
      <button
        type="button"
        className="table-action saved-remove-button"
        data-testid={`button-remove-saved-question-${question.id}`}
        disabled={isUpdating}
        onClick={onRemove}
        aria-label={`${isRemovalFailed ? 'إعادة محاولة إزالة' : 'إزالة'} السؤال ${question.id} من المحفوظات`}
      >
        <Bookmark size={14} fill="currentColor" /> {isRemovalFailed ? 'إعادة المحاولة' : 'إزالة الحفظ'}
      </button>
    </article>
  );
}

export function ReportsPage({
  learnerRequest,
  onOpenSession,
  onStartPractice,
}: {
  learnerRequest: LearnerRequest;
  onOpenSession: (sessionId: string) => void;
  onStartPractice: () => void;
}) {
  const query = useListPracticeSessions({
    request: learnerRequest,
    query: {
      queryKey: getListPracticeSessionsQueryKey(),
      retry: false,
    },
  });
  const sessions = [...(query.data ?? [])].sort(
    (first, second) => new Date(second.completedAt).getTime() - new Date(first.completedAt).getTime(),
  );

  return (
    <div className="page-wrap reports-page">
      <section className="page-heading">
        <div>
          <div className="eyebrow">Practice history · تقاريري</div>
          <h1>كل جلسة تركت أثرًا.</h1>
          <p>افتح أي جلسة مكتملة لتستعيد نتيجتها وتراجع إجاباتك، وليس آخر جلسة فقط.</p>
        </div>
        <button type="button" className="primary-button" data-testid="button-start-from-reports" onClick={onStartPractice}>
          <FileQuestion size={16} /> جلسة جديدة
        </button>
      </section>

      <section className="reports-summary-grid">
        <div className="panel reports-summary-card">
          <div className="reports-summary-icon"><History size={19} /></div>
          <div>
            <span className="card-kicker">سجل التدريب</span>
            <strong data-testid="text-report-session-count">{query.isLoading || query.isError ? '—' : sessions.length}</strong>
            <span>جلسات مكتملة</span>
          </div>
        </div>
        <div className="panel reports-summary-card reports-summary-card-accent">
          <div className="reports-summary-icon"><Target size={19} /></div>
          <div>
            <span className="card-kicker">متوسط السجل</span>
            <strong data-testid="text-report-average-score">
              {query.isLoading || query.isError || sessions.length === 0 ? '—' : `${Math.round(sessions.reduce((total, session) => total + session.score, 0) / sessions.length)}%`}
            </strong>
            <span>عبر الجلسات المكتملة</span>
          </div>
        </div>
      </section>

      <section className="panel reports-list-panel">
        <div className="panel-heading">
          <div>
            <span className="card-kicker">Completed sessions</span>
            <h2>الجلسات المكتملة</h2>
          </div>
          {sessions.length > 0 && <span className="history-result-count">{sessions.length} جلسات</span>}
        </div>
        {query.isLoading ? <HistorySkeleton label="reports" /> : null}
        {query.isError ? <HistoryError label="reports" onRetry={() => void query.refetch()} /> : null}
        {!query.isLoading && !query.isError && sessions.length === 0 ? (
          <HistoryEmpty label="reports" onAction={onStartPractice} />
        ) : null}
        {!query.isLoading && !query.isError && sessions.length > 0 ? (
          <div className="session-history-list">
            {sessions.map((session) => (
              <button
                type="button"
                className="session-history-row"
                data-testid={`button-open-session-${session.id}`}
                key={session.id}
                onClick={() => onOpenSession(session.id)}
              >
                <span className="session-history-score">{session.score}%</span>
                <span className="session-history-main">
                  <strong>{modeLabels[session.mode]}</strong>
                  <span><CalendarDays size={13} /> {session.completionReason === 'time_expired' ? 'انتهى الوقت · ' : ''}{formatSessionDate(session.completedAt)}</span>
                </span>
                <span className="session-history-count"><FileQuestion size={14} /> {session.questionCount} سؤال</span>
                <ChevronLeft size={17} className="session-history-arrow" />
              </button>
            ))}
          </div>
        ) : null}
      </section>

      <div className="reports-note">
        <Clock3 size={16} />
        <span>تظهر الجلسة في هذا السجل بعد إكمالها. الإجابات والنتيجة محفوظتان للمراجعة لاحقًا.</span>
      </div>
    </div>
  );
}