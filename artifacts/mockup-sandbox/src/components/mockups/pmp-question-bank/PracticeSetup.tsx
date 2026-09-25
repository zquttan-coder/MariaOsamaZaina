import { ArrowLeft, ArrowRight, BookOpen, Check, Clock3, Layers3, Shuffle, TimerReset } from "lucide-react";
import { useState } from "react";
import { goTo, Shell } from "./_shared/Shell";

type Mode = "quick" | "domain" | "mock";

const domains = [
  { id: "mixed", label: "مختلط", english: "All domains", icon: Shuffle, tone: "var(--pmp-teal)" },
  { id: "people", label: "الأشخاص", english: "People", icon: BookOpen, tone: "var(--pmp-coral)" },
  { id: "process", label: "العمليات", english: "Process", icon: Layers3, tone: "var(--pmp-sun)" },
];

export function PracticeSetup() {
  const [mode, setMode] = useState<Mode>("quick");
  const [domain, setDomain] = useState("mixed");
  const [count, setCount] = useState(10);
  const [timed, setTimed] = useState(true);

  return <Shell active="practice" breadcrumb="إعداد جلسة جديدة">
    <div className="pmp-content pmp-stagger">
      <div className="pmp-eyebrow">جلسة تدريب جديدة</div>
      <h1 className="pmp-heading">اختاري شكل التدريب<br /><em>الذي يناسب يومك.</em></h1>
      <p className="pmp-intro">يمكنك تغيير الإعدادات في أي وقت. الجلسة القصيرة أفضل من انتظار الوقت المثالي.</p>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.2fr) minmax(280px, .8fr)", gap: 20, marginTop: 32, alignItems: "start" }}>
        <div className="pmp-card pmp-card-pad">
          <div className="pmp-section-head"><div><h2 className="pmp-section-title">نوع الجلسة</h2><div className="pmp-section-note" style={{ marginTop: 4 }}>حددي هدفك قبل البدء</div></div><span className="pmp-chip pmp-chip-teal">١ / ٣</span></div>
          <div style={{ display: "grid", gap: 10 }}>
            {[
              { id: "quick" as Mode, title: "تدريب سريع", desc: "أسئلة قصيرة للحفاظ على الإيقاع", meta: "٥–٢٠ سؤالًا", icon: TimerReset },
              { id: "domain" as Mode, title: "تقوية مجال", desc: "ركّزي على مجال واحد يحتاج مراجعة", meta: "اختاري domain", icon: Layers3 },
              { id: "mock" as Mode, title: "محاكاة اختبار", desc: "جلسة كاملة بظروف قريبة من الاختبار", meta: "١٨٠ سؤالًا", icon: Clock3 },
            ].map((item) => {
              const Icon = item.icon;
              return <button type="button" key={item.id} onClick={() => setMode(item.id)} style={{ display: "flex", alignItems: "center", gap: 13, textAlign: "right", padding: "15px 14px", borderRadius: 15, border: `1px solid ${mode === item.id ? "#a4ccc4" : "var(--pmp-line)"}`, background: mode === item.id ? "#eef7f3" : "#fffefa", color: "var(--pmp-ink)" }}>
                <span style={{ display: "grid", placeItems: "center", flex: "0 0 36px", width: 36, height: 36, borderRadius: 11, background: mode === item.id ? "var(--pmp-teal)" : "#f0f3ed", color: mode === item.id ? "#fff" : "var(--pmp-teal)" }}><Icon size={17} /></span>
                <span style={{ flex: 1 }}><strong style={{ display: "block", fontSize: 13 }}>{item.title}</strong><span style={{ display: "block", color: "var(--pmp-muted)", fontSize: 11, marginTop: 4 }}>{item.desc}</span></span>
                <span style={{ color: "var(--pmp-muted)", fontSize: 10 }}>{item.meta}</span>
                <span style={{ width: 17, height: 17, borderRadius: "50%", border: `1.5px solid ${mode === item.id ? "var(--pmp-teal)" : "#c8d2cb"}`, display: "grid", placeItems: "center" }}>{mode === item.id && <Check size={11} />}</span>
              </button>;
            })}
          </div>

          <div style={{ borderTop: "1px solid #edf0eb", marginTop: 27, paddingTop: 24 }}>
            <div className="pmp-section-head"><div><h2 className="pmp-section-title">مجال التركيز</h2><div className="pmp-section-note" style={{ marginTop: 4 }}>اختاري ما تريدين رؤيته الآن</div></div></div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 9 }}>
              {domains.map((item) => {
                const Icon = item.icon;
                return <button type="button" key={item.id} onClick={() => setDomain(item.id)} style={{ textAlign: "right", padding: "13px 12px", borderRadius: 13, border: `1px solid ${domain === item.id ? item.tone : "var(--pmp-line)"}`, background: domain === item.id ? "#fffdf6" : "#fffefa", color: "var(--pmp-ink)" }}><Icon size={16} color={item.tone} /><strong style={{ display: "block", fontSize: 12, marginTop: 11 }}>{item.label}</strong><span className="pmp-mono" style={{ color: "var(--pmp-muted)", fontSize: 9 }}>{item.english}</span></button>;
              })}
            </div>
          </div>
        </div>

        <aside className="pmp-card pmp-card-pad" style={{ position: "sticky", top: 20 }}>
          <div className="pmp-chip pmp-chip-sun">ملخص الجلسة</div>
          <h2 style={{ fontSize: 20, margin: "14px 0 5px", letterSpacing: "-.04em" }}>{mode === "quick" ? "تدريب سريع" : mode === "domain" ? "تقوية مجال" : "محاكاة اختبار"}</h2>
          <p style={{ color: "var(--pmp-muted)", lineHeight: 1.6, fontSize: 11, margin: 0 }}>جلسة مصممة لتثبيت معرفتك دون تشتيت.</p>
          <div style={{ background: "#f6f5ef", borderRadius: 15, padding: "14px 15px", marginTop: 23 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, paddingBottom: 12, borderBottom: "1px solid #e6e8df" }}><span style={{ color: "var(--pmp-muted)" }}>المجال</span><strong>{domains.find((d) => d.id === domain)?.label}</strong></div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "12px 0", borderBottom: "1px solid #e6e8df" }}><span style={{ color: "var(--pmp-muted)" }}>عدد الأسئلة</span><strong className="pmp-mono">{mode === "mock" ? "١٨٠" : count}</strong></div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, paddingTop: 12 }}><span style={{ color: "var(--pmp-muted)" }}>الوقت</span><strong>{mode === "mock" ? "٢٣٠ دقيقة" : timed ? "مؤقت · ٢ دقيقة/سؤال" : "بدون مؤقت"}</strong></div>
          </div>
          {mode !== "mock" && <div style={{ marginTop: 23 }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 11 }}><span style={{ fontSize: 12, fontWeight: 800 }}>عدد الأسئلة</span><span className="pmp-chip pmp-chip-teal">{count} سؤالًا</span></div><div style={{ display: "flex", gap: 7 }}>{[5, 10, 15, 20].map((number) => <button type="button" key={number} onClick={() => setCount(number)} className={count === number ? "pmp-btn pmp-btn-secondary" : "pmp-btn pmp-btn-quiet"} style={{ flex: 1, padding: "9px 5px", fontSize: 11 }}>{number}</button>)}</div></div>}
          {mode !== "mock" && <button type="button" onClick={() => setTimed(!timed)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", border: 0, background: "none", marginTop: 20, padding: 0, color: "var(--pmp-ink)" }}><span style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 12, fontWeight: 700 }}><Clock3 size={15} color="var(--pmp-teal)" /> مؤقت لكل سؤال</span><span style={{ width: 35, height: 20, padding: 2, borderRadius: 20, background: timed ? "var(--pmp-teal)" : "#ced7d1", textAlign: timed ? "left" : "right", direction: "ltr" }}><span style={{ display: "block", width: 16, height: 16, borderRadius: "50%", background: "#fff" }} /></span></button>}
          <button type="button" className="pmp-btn pmp-btn-primary" onClick={() => goTo("Question")} style={{ width: "100%", marginTop: 25 }}>ابدئي الجلسة <ArrowLeft size={15} /></button>
          <div style={{ textAlign: "center", color: "var(--pmp-muted)", fontSize: 10, marginTop: 12 }}>يمكنك إيقاف الجلسة مؤقتًا في أي وقت</div>
        </aside>
      </div>
    </div>
  </Shell>;
}