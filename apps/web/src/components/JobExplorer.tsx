import { CheckIcon } from "@animateicons/react/lucide";
import type { JobDetail, JobSummary } from "@tallo/contracts";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, Bookmark, BriefcaseBusiness, Check, ChevronDown, Compass, Globe2, MapPin, Search, ShieldCheck, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { JobFacts } from "@/components/JobFacts";
import { ago, experience, salary } from "@/lib/format";

const filterKeys = ["workMode", "postedWithinDays", "country", "salaryMin", "maxExperience", "all"];
const colors = ["lilac", "peach", "mint", "blue", "rose"];
function CompanyMark({ company, large = false }: { company: string; large?: boolean }) {
  const index = [...company].reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % colors.length;
  return <span className={`company-mark ${colors[index]} ${large ? "large" : ""}`} aria-hidden="true">{company.trim().slice(0, 2).toLowerCase()}</span>;
}
function SaveButton({ saved, onClick }: { saved: boolean; onClick: () => void }) {
  return <button type="button" className={`icon-button save-button ${saved ? "is-saved" : ""}`} onClick={onClick} aria-label={saved ? "Remove saved role" : "Save role"} aria-pressed={saved}><Bookmark size={18} fill={saved ? "currentColor" : "none"} /></button>;
}
function Description({ text }: { text: string }) {
  return <div className="description-copy">{text.split(/\n\s*\n/).filter(Boolean).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>;
}

export function JobExplorer({ jobs, nextCursor, values }: { jobs: JobSummary[]; nextCursor: string | null; values: Record<string, string> }) {
  const [selected, setSelected] = useState<JobSummary | null>(jobs[0] ?? null);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [saved, setSaved] = useState<JobSummary[]>([]);
  const [storageReady, setStorageReady] = useState(false);
  const [notice, setNotice] = useState("");
  const [sort, setSort] = useState("newest");
  const cache = useRef(new Map<number, { job: JobDetail; expires: number }>());
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const lastOpened = useRef<HTMLAnchorElement | null>(null);
  const savedView = values.saved === "true";
  const active = filterKeys.filter(key => values[key]).length;
  const shownJobs = [...(savedView ? saved : jobs)].sort((a, b) => sort === "salary" ? (b.salaryMaxAnnual ?? b.salaryMinAnnual ?? -1) - (a.salaryMaxAnnual ?? a.salaryMinAnnual ?? -1) : b.sortAt - a.sortAt);
  useEffect(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem("tallo:saved-roles") ?? "[]");
      if (Array.isArray(stored)) setSaved(stored.filter((item) => item && typeof item.id === "number" && typeof item.title === "string" && typeof item.company === "string"));
    } catch { /* A fresh collection is available when storage is unavailable. */ }
    setStorageReady(true);
  }, []);
  useEffect(() => {
    if (!storageReady) return;
    if (savedView) setSelected(current => saved.find(job => job.id === current?.id) ?? saved[0] ?? null);
  }, [savedView, saved, storageReady]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 3000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!selected) return;
    const cached = cache.current.get(selected.id);
    setError(false);
    if (cached && cached.expires > Date.now()) { setDetail(cached.job); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setDetail(null);
    fetch(`/api/jobs/${selected.id}.json`, { signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error("Unavailable"); return response.json() as Promise<JobDetail>; })
      .then(job => { if (controller.signal.aborted) return; cache.current.set(job.id, { job, expires: Date.now() + 300000 }); setDetail(job); })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [selected, retry]);
  useEffect(() => {
    if (!mobileDetail) return;
    detailHeading.current?.focus();
    function close(event: KeyboardEvent) { if (event.key === "Escape") { setMobileDetail(false); lastOpened.current?.focus(); } }
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [mobileDetail]);
  function toggleSave(job: JobSummary) {
    const exists = saved.some(item => item.id === job.id);
    const next = exists ? saved.filter(item => item.id !== job.id) : [...saved, job];
    setSaved(next);
    try { localStorage.setItem("tallo:saved-roles", JSON.stringify(next)); setNotice(exists ? "Role removed from saved" : "Role saved for later"); }
    catch { setNotice("Saved for this visit. Browser storage is unavailable."); }
  }
  function linkWith(name: string, value: string) {
    const query = new URLSearchParams(values); query.delete("cursor");
    if (value) query.set(name, value); else query.delete(name);
    return `/?${query}`;
  }
  const next = new URLSearchParams(values); if (nextCursor) next.set("cursor", nextCursor);
  const current = detail?.id === selected?.id ? detail : null;
  const applyUrl = (current ?? selected)?.applyUrl ?? (current ?? selected)?.url;
  return <MotionConfig reducedMotion="user">
    <div className="workspace">
      <aside className={`filter-sidebar ${filtersOpen ? "filters-visible" : ""}`} aria-label="Job filters">
        <div className="sidebar-heading"><span>YOUR WORKSPACE</span><button className="icon-button mobile-only" type="button" aria-label="Close filters" onClick={() => setFiltersOpen(false)}><X size={18} /></button></div>
        <nav className="workspace-nav" aria-label="Workspace"><a className={!savedView ? "active" : ""} href="/"><Compass size={18} />Discover roles<ArrowUpRight size={16} /></a><a className={savedView ? "active" : ""} href="/?saved=true"><Bookmark size={18} />Saved roles<span className="nav-count">{saved.length}</span></a></nav>
        <div className="filter-heading"><h2>Make it your own</h2>{active > 0 && <a href="/" className="text-link">Reset</a>}</div>
        <form method="get" className="filter-form">
          {values.q && <input type="hidden" name="q" value={values.q} />}
          <fieldset><legend>Work preference</legend>{[["", "Anywhere"], ["remote", "Remote"], ["hybrid", "Hybrid"], ["onsite", "On-site"]].map(([value, label]) => <label className="radio-row" key={value}><input type="radio" name="workMode" value={value} defaultChecked={(values.workMode ?? "") === value} /><span>{label}</span>{value === "remote" && <Globe2 size={14} />}</label>)}</fieldset>
          <label className="field-label">Date posted<select name="postedWithinDays" defaultValue={values.postedWithinDays ?? ""}><option value="">Any time</option><option value="1">Past 24 hours</option><option value="7">Past week</option><option value="30">Past month</option></select></label>
          <label className="field-label">Minimum annual salary<select name="salaryMin" defaultValue={values.salaryMin ?? ""}><option value="">Any salary</option><option value="80000">$80,000+</option><option value="120000">$120,000+</option><option value="160000">$160,000+</option><option value="200000">$200,000+</option></select></label>
          <details className="extra-filters" open={Boolean(values.country || values.maxExperience || values.all)}><summary>More preferences <ChevronDown size={14} /></summary><label className="field-label">Country code<input name="country" maxLength={2} placeholder="e.g. US" defaultValue={values.country ?? ""} /></label><label className="field-label">Maximum experience (years)<input type="number" min="0" name="maxExperience" placeholder="Any experience" defaultValue={values.maxExperience ?? ""} /></label><label className="radio-row"><input type="checkbox" name="all" value="true" defaultChecked={values.all === "true"} />Include hidden jobs</label></details>
          <button className="button filter-submit" type="submit">Apply filters <ArrowRight size={16} /></button>
        </form>
        <div className="sidebar-note"><span className="note-icon"><ShieldCheck size={20} /></span><h3>One step closer.</h3><p>Real opportunities. Original job posts. Apply directly with the company.</p><span className="note-rule" /></div>
        <div className="sidebar-foot"><span className="status-dot" />Built for your next move</div>
      </aside>
      <div className="discovery-content">
        <section className="discovery-hero">
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .45 }}><div className="eyebrow"><span /> A LITTLE CURIOSITY. A NEW CHAPTER.</div><h1>{savedView ? <>Good things,<br className="mobile-only" /> worth keeping<span>.</span></> : <>Find work that<br className="mobile-only" /> feels like <em>you.</em></>}</h1><p>{savedView ? "Your shortlist of possibilities. Take the next step when you’re ready." : "Explore tech roles, follow your curiosity, and make your next move."}</p></motion.div>
          <div className="hero-art" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="orbit orbit-three" /><span className="art-star">✳</span><span className="art-caption">ROOM TO GROW</span></div>
        </section>
        <form method="get" className="search-bar" role="search"><Search size={20} aria-hidden="true" /><label htmlFor="job-search" className="sr-only">Search title, company, or keyword</label><input id="job-search" name="q" defaultValue={values.q ?? ""} placeholder="Job title, company, or a little inspiration…" />{filterKeys.filter(key => values[key]).map(key => <input key={key} type="hidden" name={key} value={values[key]} />)}<kbd aria-hidden="true">↵</kbd><button type="submit" className="button primary-button">Find my next role <ArrowRight size={16} /></button></form>
        <div className="quick-filters"><span>Explore</span>{[["", "All roles"], ["remote", "Remote friendly"]].map(([value, label]) => <a key={label} className={`filter-chip ${(values.workMode ?? "") === value && !values.postedWithinDays && !savedView ? "selected" : ""}`} href={linkWith("workMode", value)}>{value === "remote" && <Globe2 size={13} />}{label}</a>)}<a className={`filter-chip ${values.postedWithinDays === "7" ? "selected" : ""}`} href={linkWith("postedWithinDays", values.postedWithinDays === "7" ? "" : "7")}><Sparkles size={13} />Fresh this week</a><button type="button" className="filter-chip mobile-filter-button" onClick={() => setFiltersOpen(true)}><SlidersHorizontal size={14} />Filters{active ? ` (${active})` : ""}</button><span className="source-note"><ShieldCheck size={14} />Straight from the source</span></div>
        <div className="results-heading"><div><h2>{savedView ? "Your saved roles" : values.q ? `Results for “${values.q}”` : "Your next possibility"}</h2><span className="results-count">{shownJobs.length}{nextCursor && !savedView ? "+" : ""} roles</span></div><label className="sort-control">Sort by<select aria-label="Sort current results" value={sort} onChange={event => setSort(event.target.value)}><option value="newest">Newest first</option><option value="salary">Highest salary</option></select><ArrowDown size={13} /></label></div>
        <div className="results-layout">
          <section className="results-list" aria-label="Available roles">
            <ul>{shownJobs.map((job, index) => <motion.li key={job.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .25, delay: Math.min(index * .035, .25) }} className={`job-card ${selected?.id === job.id ? "selected" : ""}`}><div className="job-card-top"><CompanyMark company={job.company} /><div className="company-caption"><span>{job.company}</span><span>{ago(job.postedAt ?? job.sortAt)}</span></div><SaveButton saved={saved.some(item => item.id === job.id)} onClick={() => toggleSave(job)} /></div><a href={`/jobs/${job.id}`} className="job-title-link" aria-current={selected?.id === job.id ? "true" : undefined} onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); lastOpened.current = event.currentTarget; setSelected(job); setMobileDetail(true); }}><h3>{job.title}</h3><span className="card-arrow" aria-hidden="true"><ArrowUpRight size={18} /></span></a><p className="job-location"><MapPin size={13} />{job.locationText ?? "Location not listed"}</p><div className="job-tags">{job.workMode && <span className={job.workMode === "remote" ? "remote-tag" : ""}>{job.workMode === "remote" && <span />}{job.workMode === "onsite" ? "On-site" : job.workMode}</span>}{job.employmentType && <span>{job.employmentType.replaceAll("_", " ")}</span>}{experience(job.expMinYears) && <span>{experience(job.expMinYears)}</span>}</div><div className="job-card-bottom"><strong>{salary(job) ?? "Salary not listed"}</strong>{selected?.id === job.id ? <span className="viewing-label"><Check size={12} />Viewing</span> : <span>View role <ArrowRight size={13} /></span>}</div></motion.li>)}</ul>
            {!shownJobs.length && <div className="empty-results"><Compass size={32} /><h3>{savedView ? "Make room for possibilities." : "A fresh direction?"}</h3><p>{savedView ? "Save a role with the bookmark button. Your shortlist will be right here, on this browser." : "No roles match these preferences. Try a broader search or clear a filter."}</p><a href="/" className="button primary-button">{savedView ? "Discover roles" : "Clear filters"}<ArrowRight size={16} /></a></div>}
            {nextCursor && !savedView && <a className="button next-page" href={`/?${next}`}>Explore more roles <ArrowRight size={16} /></a>}
            <p className="list-end">A little closer to what’s next.</p>
          </section>
          <aside className={`detail-panel ${mobileDetail ? "mobile-detail-open" : ""}`} aria-label="Role details">
            {selected ? <><div className="detail-toolbar"><button type="button" className="text-link detail-back" onClick={() => { setMobileDetail(false); lastOpened.current?.focus(); }}><ArrowLeft size={16} />Back to roles</button><span className="detail-label"><span className="status-dot" />THE OPPORTUNITY</span><a href={`/jobs/${selected.id}`} className="icon-button" aria-label="Open full job page"><ArrowUpRight size={17} /></a></div><AnimatePresence mode="wait" initial={false}><motion.article key={selected.id} initial={{ opacity: 0, y: 7 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: .18 }} className="detail-article"><div className="detail-company"><CompanyMark company={selected.company} large /><div><p>{selected.company}</p><span>{selected.department ?? "Explore the team"}</span></div><SaveButton saved={saved.some(job => job.id === selected.id)} onClick={() => toggleSave(selected)} /></div><h2 ref={detailHeading} tabIndex={-1}>{selected.title}</h2><p className="detail-location"><MapPin size={15} />{selected.locationText ?? "Location not listed"}<span>·</span>{ago(selected.postedAt ?? selected.sortAt)}</p><div className="detail-stats"><div><span>COMPENSATION</span><strong>{salary(selected) ?? "Not listed"}</strong></div><div><span>WORK STYLE</span><strong className="capitalize">{selected.workMode ?? "Not listed"}</strong></div></div><div className="apply-row">{applyUrl ? <a href={applyUrl} target="_blank" rel="noopener noreferrer" className="button primary-button">Apply for this role <ArrowUpRight size={17} /></a> : <span className="unavailable-link">Application link unavailable</span>}<a href={`/jobs/${selected.id}`} className="button secondary-button" aria-label="Open full role details"><ArrowUpRight size={18} /></a></div><p className="apply-note"><ShieldCheck size={13} />Apply directly on the company’s website</p><div className="detail-section-heading"><h3>About the role</h3><span><BriefcaseBusiness size={14} />{selected.employmentType?.replaceAll("_", " ") ?? "Opportunity"}</span></div>{loading ? <div className="description-skeleton" role="status"><span className="sr-only">Loading role details</span><i /><i /><i /><i /><i /></div> : error ? <div className="detail-error"><p>We couldn’t load the full description.</p><button type="button" className="button secondary-button" onClick={() => setRetry(value => value + 1)}>Try again</button>{selected.excerpt && <p>{selected.excerpt}</p>}</div> : <><Description text={current?.description ?? "The full description is available on the company’s website."} />{current && <div className="structured-facts"><JobFacts facts={current.facts} /></div>}</>}<div className="detail-end"><span className="brand-mark small" aria-hidden="true"><i /><i /><i /></span><p>Your next chapter could start here.</p></div></motion.article></AnimatePresence></> : <div className="empty-detail"><Compass size={40} /><h2>Possibility is a click away.</h2><p>Choose a role to get to know the team, the work, and what comes next.</p></div>}
          </aside>
        </div>
      </div>
    </div>
    <div className="toast-region" role="status" aria-live="polite"><AnimatePresence>{notice && <motion.div className="save-toast" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}><CheckIcon size={18} color="currentColor" duration={.5} />{notice}</motion.div>}</AnimatePresence></div>
  </MotionConfig>;
}
