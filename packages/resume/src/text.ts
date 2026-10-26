import type { Resume } from "@tallo/contracts";

const dates = (item: { start: string; end: string }) =>
  [item.start, item.end].filter(Boolean).join(" – ");

const bullets = (items: string[]) => items.filter(Boolean).map((item) => `- ${item}`);

/**
 * The resume as plain text, in reading order. Models read this form, the profile is built from it, and the
 * tailoring guard searches it, so every fact the resume holds appears here exactly once.
 */
export function resumeToText(resume: Resume): string {
  const out: string[] = [];
  const block = (heading: string, body: string[]) => {
    const kept = body.filter(Boolean);
    if (kept.length) out.push(`${heading}\n${kept.join("\n")}`);
  };

  const contact = [resume.email, resume.phone, resume.location, ...resume.links.map((l) => l.url)];
  out.push(
    [resume.name, resume.headline, contact.filter(Boolean).join(" | ")].filter(Boolean).join("\n"),
  );
  block("SUMMARY", [resume.summary]);
  block(
    "EXPERIENCE",
    resume.experience.map((job) =>
      [
        [job.title, job.company, job.location].filter(Boolean).join(", "),
        dates(job),
        ...bullets(job.bullets),
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  );
  block(
    "PROJECTS",
    resume.projects.map((project) =>
      [[project.name, project.url].filter(Boolean).join(" "), ...bullets(project.bullets)]
        .filter(Boolean)
        .join("\n"),
    ),
  );
  block(
    "EDUCATION",
    resume.education.map((school) =>
      [
        [school.degree, school.school, school.location].filter(Boolean).join(", "),
        dates(school),
        ...bullets(school.details),
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  );
  block(
    "SKILLS",
    resume.skills.map(
      (group) => `${group.label ? `${group.label}: ` : ""}${group.items.join(", ")}`,
    ),
  );
  for (const extra of resume.extras)
    block(extra.title.toUpperCase() || "OTHER", bullets(extra.items));
  return out.filter(Boolean).join("\n\n");
}

/** True while nothing has been written yet (a fresh editor). */
export function isEmptyResume(resume: Resume): boolean {
  return resumeToText(resume).trim() === "";
}
