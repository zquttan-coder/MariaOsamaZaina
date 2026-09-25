import { ArrowLeft, Check, Clock3, Flame, Play, Sparkles, Target } from "lucide-react";
import { goTo, Ring, SectionHeader, Shell } from "./_shared/Shell";

export function Dashboard() {
  return <Shell active="dashboard">
    <div className="pmp-content pmp-stagger">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 20, alignItems: "end", flexWrap: "wrap" }}>
        <div>
          <div className="pmp-eyebrow">الأحد، ١٩ مايو ٢٠٢٤</div>
          <h1 className="pmp-heading">صباح الخير يا سارة،<br /><em>خطوتك التالية واضحة.</em></h1>
          <p className="pmp-intro">ثباتك هذا الأسبوع ممتاز. تبقّى لك ١٢ يومًا على خطتك الحالية — لنحافظ على الإيقاع.</p>
        </div>
        <button type="button" className="pmp-btn pmp-btn-primary" onClick={() => goTo("PracticeSetup")}><Play size={15} fill="currentColor" /> ابدئي جلسة اليوم</button>
      </div>

      <div className="pmp-grid" style={{ gridTemplateColumns: "minmax(0, 1.45fr) minmax(270px, .8fr)", marginTop: 34 }}>
        <section className="pmp-card pmp-card-pad" style={{ background: "var(--pmp-ink)", color: "#fffdf7", overflow: "hidden", position: "relative" }}>
          <div style={{ position: "relative", zIndex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 15 }}>
              <div><div className="pmp-chip" style={{ background: "rgba(255,255,255,.12)", color: "#e7c66d" }}><span className="pmp-dot" /> الاستعداد العام</div><div style={{ color: "#a9c0bb", fontSize: 12, marginTop: 17 }}>آخر تحديث بعد ١٨٤ سؤالًا</div></div>
              <div style={{ textAlign: "left" }}><div className="pmp-mono" style={{ fontSize: 37, color: "#f8d377", lineHeight: 1 }}>٧٢<span style={{ fontSize: 17 }}>%</span></div><div style={{ fontSize: 10, color: "#adc0b9", marginTop: 8 }}>جاهزية تقديرية</div></div>
            </div>
            <div style={{ marginTop: 26, maxWidth: 520 }}><div className="pmp-progress" style={{ background: "rgba(255,255,255,.13)" }}><span style={{ width: "72%", background: "var(--pmp-sun)" }} /></div><div style={{ display: "flex", justifyContent: "space-between", color: "#a9c0bb", fontSize: 10, marginTop: 9 }}><span>هدفك: ٨٠٪</span><span>باقي ٨ نقاط مئوية</span></div></div>
            <div style={{ display: "flex", gap: 30, marginTop: 29, flexWrap: "wrap" }}>
              <div><div className="pmp-mono" style={{ fontSize: 20 }}>١٨٤</div><div style={{ color: "#a9c0bb", fontSize: 10, marginTop: 3 }}>سؤال محلول</div></div>
              <div><div className="pmp-mono" style={{ fontSize: 20 }}>٧٨٪</div><div style={{ color: "#a9c0bb", fontSize: 10, marginTop: 3 }}>دقة آخر ٣٠ سؤالًا</div></div>
              <div><div className="pmp-mono" style={{ fontSize: 20 }}>٠٣:٤٢</div><div style={{ color: "#a9c0bb", fontSize: 10, marginTop: 3 }}>متوسط زمن السؤال</div></div>
            </div>
          </div>
          <div style={{ position: "absolute", width: 240, height: 240, borderRadius: "50%", border: "1px solid rgba(255,255,255,.09)", left: -80, bottom: -130 }} /><div style={{ position: "absolute", width: 180, height: 180, borderRadius: "50%", border: "1px solid rgba(232,176,75,.18)", left: -30, bottom: -98 }} />
        </section>
        <section className="pmp-card pmp-card-pad" style={{ display: "flex", gap: 19, alignItems: "center" }}>
          <Ring value={64} label="المنجز" color="var(--pmp-coral)" />
          <div><div className="pmp-chip pmp-chip-coral"><Target size={12} /> خطة ٣٠ يومًا</div><h2 style={{ fontSize: 17, margin: "14px 0 5px", letterSpacing: "-.03em" }}>أنت في اليوم ١٨</h2><p style={{ color: "var(--pmp-muted)", fontSize: 11, lineHeight: 1.6, margin: 0 }}>٦ أيام متتالية من التدريب. استمري بهذا النسق.</p><div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 16, color: "#ad7440", fontSize: 11, fontWeight: 800 }}><Flame size={15} fill="currentColor" /> سلسلة ٦ أيام</div></div>
        </section>
      </div>

      <div className="pmp-grid" style={{ gridTemplateColumns: "minmax(0, 1.08fr) minmax(300px, .92fr)", marginTop: 32 }}>
        <section>
          <SectionHeader title="تقدمك حسب المجال" note="متوسط الدقة في آخر المحاولات" action="عرض التفاصيل" />
          <div className="pmp-card" style={{ overflow: "hidden" }}>
            {[["People", "الأشخاص", 81, "var(--pmp-teal)"], ["Process", "العمليات", 74, "var(--pmp-sun)"], ["Business Environment", "بيئة الأعمال", 61, "var(--pmp-coral)"]].map(([english, arabic, value, color]) => <div key={String(english)} style={{ padding: "17px 21px", borderBottom: "1px solid #edf0eb" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 10 }}><div><span style={{ fontSize: 13, fontWeight: 800 }}>{arabic}</span><span className="pmp-mono" style={{ color: "var(--pmp-muted)", fontSize: 10, marginRight: 8 }}>{english}</span></div><strong className="pmp-mono" style={{ fontSize: 12, color: String(color) }}>{value}%</strong></div><div className="pmp-progress"><span style={{ width: `${value}%`, background: String(color) }} /></div>
            </div>)}
          </div>
        </section>
        <section>
          <SectionHeader title="آخر جلساتك" note="راجع ما أنجزته مؤخرًا" action="كل الجلسات" />
          <div className="pmp-card" style={{ padding: "5px 19px" }}>
            {[["اختبار مختلط · ٢٠ سؤالًا", "اليوم، ٩:٤٢ ص", "٨٤٪", "pmp-chip-teal"], ["Agile Practice · ١٠ أسئلة", "أمس، ٦:١٨ م", "٧٠٪", "pmp-chip-sun"], ["Process Domain · ١٥ سؤالًا", "١٧ مايو", "٦٧٪", "pmp-chip-coral"]].map(([title, time, score, tone]) => <div key={String(title)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "14px 0", borderBottom: "1px solid #edf0eb" }}><div><div style={{ fontSize: 12, fontWeight: 800 }}>{title}</div><div style={{ color: "var(--pmp-muted)", fontSize: 10, marginTop: 5 }}><Clock3 size={11} style={{ verticalAlign: "middle", marginLeft: 4 }} />{time}</div></div><span className={`pmp-chip ${tone}`}>{score}</span></div>)}
          </div>
        </section>
      </div>
      <section className="pmp-card" style={{ marginTop: 32, padding: "17px 21px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18, background: "var(--pmp-sun-soft)", borderColor: "#efdbab", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}><div style={{ width: 35, height: 35, borderRadius: 11, display: "grid", placeItems: "center", background: "#fff8df", color: "#a87829" }}><Sparkles size={17} /></div><div><strong style={{ fontSize: 13 }}>اقتراح اليوم: راجعي Stakeholder Engagement</strong><div style={{ color: "#877348", fontSize: 11, marginTop: 3 }}>مجالك الأضعف حاليًا — ٦١٪ دقة. ١٠ أسئلة كافية لتثبيت المفهوم.</div></div></div><button type="button" onClick={() => goTo("PracticeSetup")} className="pmp-btn pmp-btn-quiet">ابدئي المراجعة <ArrowLeft size={14} /></button>
      </section>
    </div>
  </Shell>;
}