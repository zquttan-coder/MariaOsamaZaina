import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  getListAdminUsersQueryKey,
  getListInstructorAccessAuditQueryKey,
  useListAdminUsers,
  useListInstructorAccessAudit,
  useGrantAdministratorAccess,
  useRevokeAdministratorAccess,
  useUpdateInstructorAccess,
} from "@workspace/api-client-react";
import { Check, Clock3, ShieldCheck, UserRound, X } from "lucide-react";
import { useAuth } from "@workspace/replit-auth-web";

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "تعذر إكمال الطلب.";
}

function messageForMutation(error: unknown): string {
  const status = statusCode(error);
  if (status === 401) {
    return "انتهت صلاحية جلسة الدخول. استخدم خيار تسجيل الدخول أعلى الصفحة.";
  }
  if (status === 403) {
    return "لا تملك صلاحية تنفيذ هذا التغيير.";
  }
  return messageFor(error);
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;

  const candidate = error as {
    status?: unknown;
    response?: { status?: unknown };
  };
  if (typeof candidate.status === "number") return candidate.status;
  return typeof candidate.response?.status === "number"
    ? candidate.response.status
    : undefined;
}

function displayName(user: {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}): string {
  return `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || user.email || "مستخدم";
}

function formatChangedAt(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function roleName(role: "learner" | "instructor" | "admin"): string {
  return role === "admin" ? "مسؤول" : role === "instructor" ? "مدرّس" : "متعلّم";
}

export function AdminAccessPage() {
  const queryClient = useQueryClient();
  const auth = useAuth();
  const [auditFilterDraft, setAuditFilterDraft] = useState({ account: "", actor: "" });
  const [auditFilters, setAuditFilters] = useState({ account: "", actor: "" });
  const auditParams = {
    ...(auditFilters.account ? { account: auditFilters.account } : {}),
    ...(auditFilters.actor ? { actor: auditFilters.actor } : {}),
  };
  const usersQuery = useListAdminUsers({
    query: { queryKey: getListAdminUsersQueryKey(), refetchOnMount: "always" },
  });
  const auditQuery = useListInstructorAccessAudit(auditParams, {
    query: {
      queryKey: getListInstructorAccessAuditQueryKey(auditParams),
      refetchOnMount: "always",
    },
  });
  const usersErrorStatus = statusCode(usersQuery.error);
  const auditErrorStatus = statusCode(auditQuery.error);
  const updateAccess = useUpdateInstructorAccess();
  const grantAdmin = useGrantAdministratorAccess();
  const revokeAdmin = useRevokeAdministratorAccess();
  const hasExpiredSession = [
    usersQuery.error,
    auditQuery.error,
    updateAccess.error,
    grantAdmin.error,
    revokeAdmin.error,
  ].some((error) => statusCode(error) === 401);

  const changeRole = (id: string, role: "learner" | "instructor") => {
    updateAccess.mutate(
      { id, data: { role } },
      {
        onSuccess: async () => {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: getListAdminUsersQueryKey() }),
            queryClient.invalidateQueries({ queryKey: getListInstructorAccessAuditQueryKey() }),
          ]);
        },
      },
    );
  };

  const revokeAdministratorAccess = (user: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
  }) => {
    const name = displayName(user);
    if (!window.confirm(`إزالة صلاحية المسؤول من ${name}؟ سيصبح الحساب متعلّمًا.`)) return;

    revokeAdmin.mutate(
      { id: user.id },
      {
        onSuccess: async () => {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: getListAdminUsersQueryKey() }),
            queryClient.invalidateQueries({ queryKey: getListInstructorAccessAuditQueryKey() }),
          ]);
        },
      },
    );
  };

  const grantAdministratorAccess = (user: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
  }) => {
    const name = displayName(user);
    if (!window.confirm(`منح صلاحية المسؤول لـ ${name}؟ سيتمكن الحساب من إدارة الحسابات والصلاحيات.`)) return;

    grantAdmin.mutate(
      { id: user.id, data: { confirmed: true } },
      {
        onSuccess: async () => {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: getListAdminUsersQueryKey() }),
            queryClient.invalidateQueries({ queryKey: getListInstructorAccessAuditQueryKey() }),
          ]);
        },
      },
    );
  };

  const users = usersQuery.data ?? [];
  const instructorCount = users.filter((user) => user.role === "instructor").length;
  const adminCount = users.filter((user) => user.role === "admin").length;

  return (
    <div className="page-wrap admin-access-page">
      <section className="page-heading instructor-heading">
        <div>
          <div className="eyebrow">Account administration</div>
          <h1>إدارة صلاحيات الحسابات</h1>
          <p>أدر صلاحيات المدرّسين والمسؤولين. تُسجّل كل تغييرات الصلاحيات للمراجعة.</p>
        </div>
      </section>

      <div className="admin-access-banner">
        <span className="instructor-badge"><ShieldCheck size={18} /></span>
        <div>
          <strong>مساحة إدارة آمنة</strong>
          <span>يمكن ترقية أي حساب مسجّل بعد التأكيد. قبل إزالة مسؤول، احذف بريده من ADMIN_EMAILS؛ لا يمكنك إزالة صلاحيتك أو صلاحية آخر مسؤول.</span>
        </div>
        {!usersQuery.isError && (
          <span className="pill pill-green">{adminCount} مسؤول · {instructorCount} مدرّس</span>
        )}
      </div>

      {hasExpiredSession && (
        <div className="instructor-state error-state" role="alert" data-testid="status-admin-session-expired">
          <X size={20} />
          <strong>انتهت صلاحية جلسة الدخول</strong>
          <span>سجّل الدخول مجددًا للمتابعة. ستعود إلى صفحة الإدارة بعد تسجيل الدخول.</span>
          <button
            type="button"
            className="secondary-button"
            onClick={auth.login}
            data-testid="button-admin-session-login"
          >
            تسجيل الدخول مجددًا
          </button>
        </div>
      )}

      {updateAccess.isError && (
        <div className="feedback form-error" role="alert" data-testid="status-admin-role-error">
          <X size={15} /> {messageForMutation(updateAccess.error)}
        </div>
      )}
      {updateAccess.isSuccess && (
        <div className="feedback success-feedback" role="status" data-testid="status-admin-role-updated">
          <Check size={15} /> تم تحديث الصلاحية وتسجيل التغيير.
        </div>
      )}
      {revokeAdmin.isError && (
        <div className="feedback form-error" role="alert" data-testid="status-admin-revoke-error">
          <X size={15} /> {messageForMutation(revokeAdmin.error)}
        </div>
      )}
      {revokeAdmin.isSuccess && (
        <div className="feedback success-feedback" role="status" data-testid="status-admin-revoke-success">
          <Check size={15} /> تم إلغاء صلاحية المسؤول وتسجيل التغيير.
        </div>
      )}
      {grantAdmin.isError && (
        <div className="feedback form-error" role="alert" data-testid="status-admin-grant-error">
          <X size={15} /> {messageForMutation(grantAdmin.error)}
        </div>
      )}
      {grantAdmin.isSuccess && (
        <div className="feedback success-feedback" role="status" data-testid="status-admin-grant-success">
          <Check size={15} /> تم منح صلاحية المسؤول وتسجيل التغيير.
        </div>
      )}

      <section className="panel admin-users-panel" aria-labelledby="admin-users-title">
        <div className="panel-heading">
          <div>
            <span className="card-kicker">Accounts</span>
            <h2 id="admin-users-title">الحسابات المسجّلة</h2>
          </div>
          <span className="history-result-count">{users.length} حساب</span>
        </div>

        {usersQuery.isLoading ? (
          <div className="instructor-loading" data-testid="status-admin-users-loading">
            <span /><span /><span />
          </div>
        ) : usersQuery.isError ? (
          <div className="instructor-state error-state" data-testid="status-admin-users-error">
            <X size={20} />
            <strong>
              {usersErrorStatus === 401
                ? "يلزم تسجيل الدخول مجددًا"
                : usersErrorStatus === 403
                  ? "لا تملك صلاحية عرض الحسابات"
                  : "تعذر تحميل الحسابات"}
            </strong>
            <span>
              {usersErrorStatus === 401
                ? "استخدم خيار تسجيل الدخول أعلى الصفحة."
                : usersErrorStatus === 403
                  ? "يجب أن يكون الحساب مسؤولًا للوصول إلى هذه البيانات."
                  : messageFor(usersQuery.error)}
            </span>
            {usersErrorStatus !== 401 && (
              <button type="button" className="secondary-button" onClick={() => void usersQuery.refetch()}>
                إعادة المحاولة
              </button>
            )}
          </div>
        ) : users.length === 0 ? (
          <div className="instructor-state" data-testid="status-admin-users-empty">
            <UserRound size={24} />
            <strong>لا توجد حسابات مسجّلة بعد</strong>
          </div>
        ) : (
          <div className="admin-user-list" data-testid="list-admin-users">
            {users.map((user) => {
              const isAdmin = user.role === "admin";
              const isInstructor = user.role === "instructor";
              const isSelf = user.id === auth.user?.id;
              const isChanging =
                (updateAccess.isPending && updateAccess.variables?.id === user.id) ||
                (revokeAdmin.isPending && revokeAdmin.variables?.id === user.id) ||
                (grantAdmin.isPending && grantAdmin.variables?.id === user.id);
              const isMutationPending =
                updateAccess.isPending || revokeAdmin.isPending || grantAdmin.isPending;
              return (
                <article className="admin-user-row" key={user.id} data-testid={`row-admin-user-${user.id}`}>
                  <span className={`admin-user-avatar ${isAdmin ? "admin" : ""}`}>
                    {isAdmin ? <ShieldCheck size={17} /> : <UserRound size={17} />}
                  </span>
                  <div className="admin-user-copy">
                    <strong>{displayName(user)}</strong>
                    <span>{user.email ?? "لا يوجد بريد إلكتروني"}</span>
                  </div>
                  <span className={`pill ${isAdmin ? "pill-purple" : isInstructor ? "pill-green" : "pill-slate"}`}>
                    {isAdmin ? "مسؤول" : isInstructor ? "مدرّس" : "متعلّم"}
                  </span>
                  {isAdmin ? (
                    isSelf ? (
                      <span className="admin-protected-role">لا يمكنك إزالة صلاحيتك</span>
                    ) : (
                      <button
                        type="button"
                        className="table-action archive-action"
                        disabled={isChanging || isMutationPending}
                        onClick={() => revokeAdministratorAccess(user)}
                        aria-label={`إزالة صلاحية المسؤول من ${displayName(user)}`}
                        data-testid={`button-revoke-admin-${user.id}`}
                      >
                        {isChanging ? "جارٍ الإلغاء…" : "إزالة صلاحية المسؤول"}
                      </button>
                    )
                  ) : (
                    <button
                      type="button"
                      className={`table-action ${isInstructor ? "archive-action" : "publish-action"}`}
                      disabled={isChanging || isMutationPending}
                      onClick={() => changeRole(user.id, isInstructor ? "learner" : "instructor")}
                      aria-label={isInstructor ? `إيقاف صلاحية المدرّس لـ ${displayName(user)}` : `منح صلاحية المدرّس لـ ${displayName(user)}`}
                      data-testid={`button-admin-role-${user.id}`}
                    >
                      {isChanging ? "جارٍ الحفظ…" : isInstructor ? "إيقاف الصلاحية" : "منح صلاحية المدرّس"}
                    </button>
                  )}
                  {!isAdmin && (
                    <button
                      type="button"
                      className="table-action publish-action"
                      disabled={isChanging || isMutationPending}
                      onClick={() => grantAdministratorAccess(user)}
                      aria-label={`منح صلاحية المسؤول لـ ${displayName(user)}`}
                      data-testid={`button-grant-admin-${user.id}`}
                    >
                      {grantAdmin.isPending && grantAdmin.variables?.id === user.id
                        ? "جارٍ الحفظ…"
                        : "منح صلاحية المسؤول"}
                    </button>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="panel admin-audit-panel" aria-labelledby="admin-audit-title">
        <div className="panel-heading">
          <div>
            <span className="card-kicker">Audit history</span>
            <h2 id="admin-audit-title">سجل تغييرات الصلاحيات</h2>
          </div>
          <Clock3 size={18} className="muted-icon" />
        </div>

        <form
          className="admin-audit-search"
          data-testid="form-admin-audit-search"
          onSubmit={(event) => {
            event.preventDefault();
            setAuditFilters({
              account: auditFilterDraft.account.trim(),
              actor: auditFilterDraft.actor.trim(),
            });
          }}
        >
          <label>
            <span>الحساب</span>
            <input
              type="search"
              data-testid="input-admin-audit-account"
              aria-label="ابحث باسم الحساب أو بريده أو معرّفه"
              placeholder="الاسم أو البريد الإلكتروني"
              maxLength={200}
              value={auditFilterDraft.account}
              onChange={(event) =>
                setAuditFilterDraft((current) => ({ ...current, account: event.target.value }))
              }
            />
          </label>
          <label>
            <span>بواسطة المسؤول</span>
            <input
              type="search"
              data-testid="input-admin-audit-actor"
              aria-label="ابحث باسم المسؤول أو بريده أو معرّفه"
              placeholder="اسم المسؤول أو بريده"
              maxLength={200}
              value={auditFilterDraft.actor}
              onChange={(event) =>
                setAuditFilterDraft((current) => ({ ...current, actor: event.target.value }))
              }
            />
          </label>
          <div className="admin-audit-search-actions">
            <button type="submit" className="secondary-button" data-testid="button-admin-audit-search">
              بحث في السجل
            </button>
            {(auditFilters.account || auditFilters.actor || auditFilterDraft.account || auditFilterDraft.actor) && (
              <button
                type="button"
                className="text-button"
                data-testid="button-admin-audit-clear"
                onClick={() => {
                  setAuditFilterDraft({ account: "", actor: "" });
                  setAuditFilters({ account: "", actor: "" });
                }}
              >
                مسح البحث
              </button>
            )}
          </div>
        </form>

        {auditQuery.isLoading ? (
          <div className="instructor-loading" data-testid="status-admin-audit-loading">
            <span /><span />
          </div>
        ) : auditQuery.isError ? (
          <div className="instructor-state error-state" data-testid="status-admin-audit-error">
            <X size={20} />
            <strong>
              {auditErrorStatus === 401
                ? "يلزم تسجيل الدخول مجددًا"
                : auditErrorStatus === 403
                  ? "لا تملك صلاحية عرض سجل التغييرات"
                  : "تعذر تحميل سجل التغييرات"}
            </strong>
            <span>
              {auditErrorStatus === 401
                ? "استخدم خيار تسجيل الدخول أعلى الصفحة."
                : auditErrorStatus === 403
                  ? "يجب أن يكون الحساب مسؤولًا للوصول إلى هذه البيانات."
                  : messageFor(auditQuery.error)}
            </span>
            {auditErrorStatus !== 401 && (
              <button type="button" className="secondary-button" onClick={() => void auditQuery.refetch()}>
                إعادة المحاولة
              </button>
            )}
          </div>
        ) : auditQuery.data?.length ? (
          <div className="admin-audit-list" data-testid="list-admin-access-audit">
            <div className="history-result-count" data-testid="text-admin-audit-result-count">
              {auditQuery.data.length} نتيجة
            </div>
            {auditQuery.data.map((entry) => (
              <article className="admin-audit-row" key={entry.id} data-testid={`row-admin-audit-${entry.id}`}>
                <span className="audit-change-icon"><Check size={15} /></span>
                <div className="admin-audit-copy">
                  <strong>
                    {entry.previousRole === "admin" && entry.newRole !== "admin"
                      ? `أزال صلاحية المسؤول من ${entry.targetName || entry.targetEmail || entry.targetId}`
                      : entry.newRole === "admin"
                        ? `رقّى ${entry.targetName || entry.targetEmail || entry.targetId} إلى مسؤول من ${roleName(entry.previousRole)}`
                        : `${entry.previousRole === "instructor" ? "أوقف" : "منح"} ${entry.targetName || entry.targetEmail || entry.targetId} صلاحية المدرّس`}
                  </strong>
                  <span>بواسطة {entry.actorName || entry.actorEmail || entry.actorId}</span>
                </div>
                <time dateTime={entry.changedAt}>{formatChangedAt(entry.changedAt)}</time>
              </article>
            ))}
          </div>
        ) : (
          <div className="instructor-state admin-audit-empty" data-testid="status-admin-audit-empty">
            <Clock3 size={22} />
            <strong>
              {auditFilters.account || auditFilters.actor
                ? "لا توجد تغييرات تطابق البحث"
                : "لا توجد تغييرات مسجّلة"}
            </strong>
            <span>
              {auditFilters.account || auditFilters.actor
                ? "جرّب اسمًا أو بريدًا إلكترونيًا آخر، أو امسح البحث لعرض أحدث التغييرات."
                : "ستظهر هنا التغييرات التي يجريها المسؤولون."}
            </span>
          </div>
        )}
      </section>
    </div>
  );
}