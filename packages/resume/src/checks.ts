import type { Resume } from "@tallo/contracts";

/** A fix is wrong or missing; a tip is a choice the person may want to make differently. */
export interface Check {
  level: "fix" | "tip";
  section: "contact" | "summary" | "experience" | "projects" | "education" | "skills";
  message: string;
}

type Section = Check["section"];
type Job = Resume["experience"][number];

const SUMMARY_MAX = 600;
const BULLET_MAX = 240;
const BULLETS_MAX = 7;
const LINKS_MAX = 3;
const EXCERPT_MAX = 60;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const isMonth = (word: string) => {
  const lower = word.toLowerCase();
  if (lower === "sept") return true;
  return MONTHS.some((month) => month === lower || (lower.length === 3 && month.startsWith(lower)));
};

/** "2020", "Mar 2020" or "March 2020" (years 1970-2100) are dates; "Present" or "Current" is open-ended. */
function readDate(value: string): "date" | "present" | null {
  const text = value.trim();
  if (/^(present|current)$/i.test(text)) return "present";
  const parts = text.match(/^(?:([a-z]+)\.?,?\s+)?(\d{4})$/i);
  if (!parts) return null;
  const [, month, year] = parts;
  const yearNumber = Number(year);
  if (yearNumber < 1970 || yearNumber > 2100) return null;
  if (month && !isMonth(month)) return null;
  return "date";
}

const clean = (items: string[]) => items.map((item) => item.trim()).filter(Boolean);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const excerpt = (text: string) =>
  text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX - 3)}...` : text;

/** Names a role by its company, else its title, so a message reads "your role at Acme". */
function roleName(job: Job): string {
  const company = job.company.trim();
  const title = job.title.trim();
  if (company) return `at ${company}`;
  if (title) return `(${title})`;
  return "without a name";
}

/**
 * Deterministic advice on the structured resume. Pure: no model, no network. Fixes come first, then tips;
 * within each level the order follows the resume.
 */
export function checkResume(resume: Resume): Check[] {
  const fixes: Check[] = [];
  const tips: Check[] = [];
  const fix = (section: Section, message: string) => fixes.push({ level: "fix", section, message });
  const tip = (section: Section, message: string) => tips.push({ level: "tip", section, message });

  /** Each bullet text may repeat once; the second occurrence is the one reported. */
  const seen = new Map<string, number>();
  const repeats = (section: Section, texts: string[]) => {
    for (const text of clean(texts)) {
      const count = (seen.get(text) ?? 0) + 1;
      seen.set(text, count);
      if (count === 2) tip(section, `The bullet "${excerpt(text)}" appears more than once.`);
    }
  };

  if (!resume.name.trim()) fix("contact", "Add your name.");
  const email = resume.email.trim();
  if (!email) fix("contact", "Add your email address.");
  else if (!EMAIL.test(email)) fix("contact", `"${email}" does not look like an email address.`);
  if (!resume.phone.trim()) fix("contact", "Add a phone number.");
  const links = resume.links.filter((link) => link.url.trim()).length;
  if (links > LINKS_MAX)
    tip("contact", `You list ${links} links. Keep the ${LINKS_MAX} that matter most.`);

  if (resume.summary.trim().length > SUMMARY_MAX)
    tip("summary", "Your summary runs over 600 characters. Keep it to a few sentences.");

  const roles = resume.experience.filter((job) => job.company.trim() || job.title.trim());
  if (roles.length === 0) fix("experience", "Add at least one role to your experience.");
  for (const job of roles) {
    const name = roleName(job);
    const start = job.start.trim();
    const end = job.end.trim();
    if (!start) fix("experience", `Add dates to your role ${name}.`);
    else if (readDate(start) !== "date")
      fix(
        "experience",
        `Could not read the start date "${start}" for your role ${name}. Use a year or Mon YYYY.`,
      );
    if (end && !readDate(end))
      fix(
        "experience",
        `Could not read the end date "${end}" for your role ${name}. Use a year, Mon YYYY or Present.`,
      );

    const bullets = clean(job.bullets);
    if (bullets.length === 0) fix("experience", `Add bullets to your role ${name}.`);
    if (bullets.length > 0) {
      const long = bullets.filter((bullet) => bullet.length > BULLET_MAX).length;
      if (long > 0)
        tip(
          "experience",
          `${plural(long, "bullet")} ${name} ${long === 1 ? "runs" : "run"} long. Aim for two lines.`,
        );
      const lower = bullets.filter((bullet) => /^[a-z]/.test(bullet)).length;
      if (lower > 0)
        tip(
          "experience",
          `${plural(lower, "bullet")} ${name} ${lower === 1 ? "starts" : "start"} with a lowercase letter.`,
        );
      if (bullets.length > BULLETS_MAX)
        tip(
          "experience",
          `Your role ${name} has ${bullets.length} bullets. Keep it to ${BULLETS_MAX} or fewer.`,
        );
      if (bullets.length === 1)
        tip("experience", `Your role ${name} has only one bullet. Add a second achievement.`);
    }
    repeats("experience", job.bullets);
  }

  for (const project of resume.projects) repeats("projects", project.bullets);
  for (const school of resume.education) repeats("education", school.details);

  if (!resume.skills.some((group) => clean(group.items).length > 0))
    tip("skills", "List your skills so readers and filters can find them.");

  return [...fixes, ...tips];
}
