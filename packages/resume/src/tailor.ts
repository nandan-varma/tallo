import type { Resume } from "@tallo/contracts";
import { resumeToText } from "./text.ts";

/**
 * What a model may change when it tailors a resume to a posting: the wording of the headline, summary and
 * bullets, which bullets stay, and how skills are grouped. Employers, titles, dates, schools and degrees are
 * not in this shape at all, so they cannot move.
 */
export interface Tailoring {
  headline: string;
  summary: string;
  experience: { company: string; title: string; bullets: string[] }[];
  projects: { name: string; bullets: string[] }[];
  skills: { label: string; items: string[] }[];
}

const NUMBER = /\d[\d,.]*/g;
const key = (text: string) => text.trim().toLowerCase();

/** Numbers a bullet states that the original resume never did (a model "improving" 30% into 40%). */
function inventsNumbers(bullet: string, known: Set<string>): boolean {
  return (bullet.match(NUMBER) ?? []).some((n) => !known.has(n.replace(/[.,]$/, "")));
}

/**
 * Lays a model's tailoring over the original. Facts come from the original; wording comes from the model
 * only where it passes two checks: a bullet may not state a number the resume never contained, and a skill
 * must already appear somewhere in the resume. A bullet list left empty by those checks keeps the original.
 */
export function applyTailoring(base: Resume, tailoring: Tailoring): Resume {
  const text = resumeToText(base);
  const known = new Set((text.match(NUMBER) ?? []).map((n) => n.replace(/[.,]$/, "")));
  const lower = text.toLowerCase();

  const pick = (original: string[], proposed: string[] | undefined) => {
    const kept = (proposed ?? [])
      .map((b) => b.trim())
      .filter((b) => b && !inventsNumbers(b, known));
    return kept.length ? kept : original;
  };

  const experience = base.experience.map((job, index) => {
    const match =
      tailoring.experience.find(
        (t) => key(t.company) === key(job.company) && key(t.title) === key(job.title),
      ) ?? tailoring.experience[index];
    return { ...job, bullets: pick(job.bullets, match?.bullets) };
  });

  const projects = base.projects.map((project, index) => {
    const match =
      tailoring.projects.find((t) => key(t.name) === key(project.name)) ??
      tailoring.projects[index];
    return { ...project, bullets: pick(project.bullets, match?.bullets) };
  });

  const groups = tailoring.skills
    .map((group) => ({
      label: group.label.trim(),
      items: group.items
        .map((item) => item.trim())
        .filter((item) => item && lower.includes(item.toLowerCase())),
    }))
    .filter((group) => group.items.length > 0);

  return {
    ...base,
    headline: tailoring.headline.trim() || base.headline,
    summary: inventsNumbers(tailoring.summary, known)
      ? base.summary
      : tailoring.summary.trim() || base.summary,
    experience,
    projects,
    skills: groups.length ? groups : base.skills,
  };
}
