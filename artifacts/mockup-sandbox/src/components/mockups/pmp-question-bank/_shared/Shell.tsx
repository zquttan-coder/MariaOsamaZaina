import { BarChart3, Bell, BookOpen, ChevronLeft, CircleHelp, Compass, LayoutDashboard, ListChecks, Moon, Settings2, Target } from "lucide-react";
import type { ReactNode } from "react";
import "./styles.css";

export type PmpPage = "dashboard" | "practice" | "question" | "results";

const pages: Array<{ id: PmpPage; label: string; href: string; icon: typeof LayoutDashboard }> = [
  { id: "dashboard", label: "نظرة عامة", href: "Dashboard", icon: LayoutDashboard },
  { id: "practice", label: "جلسة تدريب", href: "PracticeSetup", icon: Compass },
  { id: "question", label: "سؤال اليوم", href: "Question", icon: CircleHelp },
  { id: "results", label: "تحليل النتائج", href: "Results", icon: BarChart3 },
];

export function goTo(page: string) {
  window.location.href = `/__mockup/preview/pmp-question-bank/${page}`;
}

export function Shell({ active, children, breadcrumb }: { active: PmpPage; children: ReactNode; breadcrumb?: string }) {
  return (
    <div className="pmp-app" dir="rtl">
      <div className="pmp-shell">
        <aside className="pmp-sidebar">
          <div className="pmp-brand">
            <div className="pmp-brand-mark">P</div>
            <div><div className="pmp-brand-name">مسارك إلى PMP</div><span className="pmp-brand-sub">study companion</span></div>
          </div>
          <div>
            <div className="pmp-nav-label">مساحة التعلّم</div>
            <nav className="pmp-nav" style={{ marginTop: 10 }}>
              {pages.map((page) => {
                const Icon = page.icon;
                return <button type="button" key={page.id} onClick={() => goTo(page.href)} className={`pmp-nav-item ${active === page.id ? "active" : ""}`}><Icon /> <span>{page.label}</span></button>;
              })}
            </nav>
          </div>
          <div>
            <div className="pmp-nav-label">أخرى</div>
            <nav className="pmp-nav" style={{ marginTop: 10 }}>
              <button type="button" className="pmp-nav-item"><ListChecks /><span>خطة المراجعة</span></button>
              <button type="button" className="pmp-nav-item"><Settings2 /><span>التفضيلات</span></button>
            </nav>
          </div>
          <div className="pmp-sidebar-foot">
            <p><strong>جلسة قصيرة، أثر طويل.</strong><br />١٥ دقيقة اليوم تحافظ على إيقاعك نحو الشهادة.</p>
          </div>
        </aside>
        <main className="pmp-main">
          <header className="pmp-topbar">
            <div className="pmp-breadcrumb"><span>مسارك إلى PMP</span><ChevronLeft size={13} /><strong>{breadcrumb ?? pages.find((p) => p.id === active)?.label}</strong></div>
            <div className="pmp-top-actions">
              <button type="button" className="pmp-icon-btn" aria-label="تبديل المظهر"><Moon size={16} /></button>
              <button type="button" className="pmp-icon-btn" aria-label="الإشعارات"><Bell size={16} /></button>
              <div className="pmp-profile"><div className="pmp-avatar">س</div><div><div className="pmp-profile-name">سارة العتيبي</div><div className="pmp-profile-caption">مرشحة PMP · الرياض</div></div></div>
            </div>
          </header>
          <div className="pmp-mobile-nav">
            {pages.map((page) => {
              const Icon = page.icon;
              return <button type="button" key={page.id} onClick={() => goTo(page.href)} className={`pmp-nav-item ${active === page.id ? "active" : ""}`}><Icon /><span>{page.label}</span></button>;
            })}
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}

export function SectionHeader({ title, note, action }: { title: string; note?: string; action?: string }) {
  return <div className="pmp-section-head"><div><h2 className="pmp-section-title">{title}</h2>{note && <div className="pmp-section-note" style={{ marginTop: 4 }}>{note}</div>}</div>{action && <button type="button" className="pmp-link">{action} ←</button>}</div>;
}

export function Ring({ value, label, color = "var(--pmp-teal)" }: { value: number; label: string; color?: string }) {
  const deg = value * 3.6;
  return <div style={{ position: "relative", width: 132, height: 132 }}>
    <div style={{ width: "100%", height: "100%", borderRadius: "50%", background: `conic-gradient(${color} ${deg}deg, #e7ece6 0deg)`, padding: 10 }}>
      <div style={{ display: "grid", placeItems: "center", width: "100%", height: "100%", background: "var(--pmp-card)", borderRadius: "50%" }}><div style={{ textAlign: "center" }}><strong className="pmp-mono" style={{ display: "block", color: "var(--pmp-ink-deep)", fontSize: 27 }}>{value}%</strong><span style={{ display: "block", color: "var(--pmp-muted)", fontSize: 10, marginTop: 3 }}>{label}</span></div></div>
    </div>
  </div>;
}