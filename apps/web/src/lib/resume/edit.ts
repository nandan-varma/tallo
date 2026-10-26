import type { Resume } from "@tallo/contracts";

/** Immutable list edits the editor is built from. Out-of-range indexes leave the list as it was. */
export const replaceAt = <T>(list: readonly T[], index: number, item: T): T[] =>
  list.map((existing, i) => (i === index ? item : existing));

export const removeAt = <T>(list: readonly T[], index: number): T[] =>
  list.filter((_, i) => i !== index);

export function move<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) {
    return [...list];
  }
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}

type Of<K extends keyof Resume> = Resume[K][number];

export const blank = {
  experience: (): Of<"experience"> => ({
    company: "",
    title: "",
    location: "",
    start: "",
    end: "",
    bullets: [""],
  }),
  education: (): Of<"education"> => ({
    school: "",
    degree: "",
    location: "",
    start: "",
    end: "",
    details: [],
  }),
  project: (): Of<"projects"> => ({ name: "", url: "", bullets: [""] }),
  skill: (): Of<"skills"> => ({ label: "", items: [] }),
  extra: (): Of<"extras"> => ({ title: "", items: [""] }),
  link: (): Of<"links"> => ({ label: "", url: "" }),
};

/** Drops what the person left empty, so an unused blank bullet or entry never reaches the PDF or the model. */
export function tidy(resume: Resume): Resume {
  const text = (list: string[]) => list.map((item) => item.trim()).filter(Boolean);
  return {
    ...resume,
    links: resume.links.filter((link) => link.url.trim()),
    experience: resume.experience
      .filter((job) => job.company.trim() || job.title.trim())
      .map((job) => ({ ...job, bullets: text(job.bullets) })),
    education: resume.education
      .filter((school) => school.school.trim() || school.degree.trim())
      .map((school) => ({ ...school, details: text(school.details) })),
    skills: resume.skills
      .map((group) => ({ ...group, items: text(group.items) }))
      .filter((group) => group.items.length > 0),
    projects: resume.projects
      .filter((project) => project.name.trim())
      .map((project) => ({ ...project, bullets: text(project.bullets) })),
    extras: resume.extras
      .map((extra) => ({ ...extra, items: text(extra.items) }))
      .filter((extra) => extra.items.length > 0),
  };
}

/** Comma-separated skill text to a list, and back; the editor shows skills as one line. */
export const splitItems = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
