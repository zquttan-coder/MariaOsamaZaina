import { ArrowLeft, Bookmark, Check, ChevronLeft, Clock3, Flag, Pause, RotateCcw } from "lucide-react";
import { useState } from "react";
import { goTo, Shell } from "./_shared/Shell";

const choices = [
  { id: "A", text: "مراجعة سجل المخاطر مع الفريق وتحديث استراتيجية الاستجابة قبل اتخاذ الإجراء." },
  { id: "B", text: "إبلاغ الراعي بالمشكلة وطلب توجيهه بشأن أفضل استجابة للمخاطر." },
  { id: "C", text: "تنفيذ خطة الطوارئ المعتمدة فورًا لتقليل أثر التغيير على المشروع." },
  { id: "D", text: "إضافة المشكلة إلى Issue Log ومناقشتها في اجتماع الفريق القادم." },
];

export function Question() {
  const [selected, setSelected] = useState<string | null>(null);
  const [flagged, setFlagged] = useState(false);
  const [paused, setPaused] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  return <Shell active="question" breadcrumb="جلسة تدريب · سؤال ٠٧">
    <div className="pmp-content">
      <div style={{ maxWidth: 920, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 18, marginBottom: 17 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}><span className="pmp-chip pmp-chip-teal">Process</span><span style={{ color: "var(--pmp-muted)", fontSize: 11 }}>تدريب سريع · سؤال ٧ من ١٠</span></div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}><span className="pmp-mono" style={{ fontSize: 14, color: paused ? "var(--pmp-coral)" : "var(--pmp-ink)" }}>{paused ? "متوقف" : "٠١:٢٨"}</span><button type="button" className="pmp-icon-btn" onClick={() => setPaused(!paused)} aria-label={paused ? "استئناف المؤقت" : "إيقاف المؤقت"}>{paused ? <RotateCcw size={15} /> : <Pause size={15} />}</button></div>
        </div>
        <div className="pmp-progress" style={{ height: 5, marginBottom: 34 }}><span style={{ width: "60%" }} /></div>

        <div className="pmp-card pmp-card-pad" style={{ padding: "clamp(20px, 4vw, 39px)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "start" }}>
            <div style={{ color: "var(--pmp-muted)", fontSize: 11, fontWeight: 700 }}>Scenario-based question · <span className="pmp-mono">PMP-0427</span></div>
            <button type="button" onClick={() => setFlagged(!flagged)} style={{ display: "flex", alignItems: "center", gap: 6, border: 0, background: "none", color: flagged ? "var(--pmp-coral)" : "var(--pmp-muted)", fontSize: 11, fontWeight: 700 }}><Flag size={14} fill={flagged ? "currentColor" : "none"} /> {flagged ? "تمت العلامة" : "مراجعة لاحقًا"}</button>
          </div>
          <h1 style={{ fontSize: "clamp(19px, 2.5vw, 26px)", lineHeight: 1.65, letterSpacing: "-.035em", color: "var(--pmp-ink-deep)", margin: "25px 0 9px" }}>أثناء تنفيذ مشروع، اكتشف مدير المشروع أن أحد المخاطر المحددة قد وقع وأصبح يؤثر في الجدول الزمني. ما أول إجراء ينبغي على مدير المشروع اتخاذه؟</h1>
          <p style={{ color: "var(--pmp-muted)", fontSize: 12, lineHeight: 1.7, margin: 0 }}>اختر أفضل إجابة واحدة وفقًا لممارسات PMI.</p>
          <div style={{ display: "grid", gap: 10, marginTop: 30 }}>
            {choices.map((choice) => <button type="button" key={choice.id} onClick={() => !submitted && setSelected(choice.id)} style={{ display: "flex", alignItems: "start", gap: 13, width: "100%", textAlign: "right", padding: "15px 15px", borderRadius: 14, border: `1px solid ${selected === choice.id ? "var(--pmp-teal)" : "var(--pmp-line)"}`, background: selected === choice.id ? "#eff8f4" : "#fffefa", color: "var(--pmp-ink)" }}>
              <span className="pmp-mono" style={{ flex: "0 0 25px", display: "grid", placeItems: "center", width: 25, height: 25, borderRadius: 8, background: selected === choice.id ? "var(--pmp-teal)" : "#f0f3ed", color: selected === choice.id ? "#fff" : "var(--pmp-ink)", fontSize: 11, fontWeight: 500 }}>{selected === choice.id ? <Check size={14} /> : choice.id}</span><span style={{ fontSize: 13, lineHeight: 1.7 }}>{choice.text}</span>
            </button>)}
          </div>
          {submitted && <div style={{ display: "flex", gap: 10, alignItems: "start", marginTop: 19, padding: "14px 15px", borderRadius: 13, background: "#fff5df", color: "#7e632a", fontSize: 11, lineHeight: 1.7 }}><Bookmark size={16} style={{ flex: "0 0 auto", marginTop: 2 }} /><span><strong>إجابة محفوظة للمراجعة.</strong> الإجابة النموذجية هي A: ابدأ بمراجعة سجل المخاطر وتحديث خطة الاستجابة.</span></div>}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 13, marginTop: 30, paddingTop: 21, borderTop: "1px solid #edf0eb", flexWrap: "wrap" }}>
            <button type="button" className="pmp-btn pmp-btn-quiet" onClick={() => goTo("PracticeSetup")}><ChevronLeft size={15} /> إنهاء الجلسة</button>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}><span style={{ color: "var(--pmp-muted)", fontSize: 10 }}>{selected ? "اختيارك محفوظ محليًا" : "اختاري إجابة للمتابعة"}</span><button type="button" disabled={!selected} onClick={() => { if (!submitted) setSubmitted(true); else goTo("Results"); }} className="pmp-btn pmp-btn-primary" style={{ opacity: selected ? 1 : .46 }}>{submitted ? "السؤال التالي" : "تأكيد الإجابة"} <ArrowLeft size={15} /></button></div>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 8, marginTop: 22, color: "var(--pmp-muted)", fontSize: 10 }}><Clock3 size={12} /> خذي وقتك في قراءة السيناريو · يمكنك وضع علامة للمراجعة</div>
      </div>
    </div>
  </Shell>;
}