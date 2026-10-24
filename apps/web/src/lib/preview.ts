import type { JobDetail, JobPage } from "@tallo/contracts";

/** Fictional example openings for the explicitly enabled local design preview only. */
const examples = [
  ["Linear", "Senior Frontend Engineer", "San Francisco, CA", "remote", 180000, 240000, "Product Engineering", "https://linear.app/careers"],
  ["Notion", "Product Engineer, Core Experience", "New York, NY", "hybrid", 165000, 225000, "Core Product", "https://www.notion.com/careers"],
  ["Vercel", "Design Engineer", "United States", "remote", 160000, 220000, "Design Engineering", "https://vercel.com/careers"],
  ["Stripe", "Software Engineer, Developer Experience", "San Francisco, CA", "hybrid", 180000, 260000, "Developer Experience", "https://stripe.com/jobs"],
  ["Figma", "Senior Product Designer", "New York, NY", "hybrid", 170000, 235000, "Product Design", "https://www.figma.com/careers/"],
  ["Ramp", "Full Stack Engineer", "United States", "remote", 155000, 215000, "Product Engineering", "https://ramp.com/careers"],
  ["Anthropic", "Software Engineer, Product", "San Francisco, CA", "onsite", 200000, 280000, "Product", "https://www.anthropic.com/careers"],
  ["Raycast", "Frontend Engineer", "United States", "remote", 145000, 190000, "Engineering", "https://www.raycast.com/careers"],
  ["Airbnb", "Staff Software Engineer", "United States", "remote", 210000, 290000, "Guest Experience", "https://careers.airbnb.com/"],
  ["Webflow", "Product Engineer, Collaboration", "United States", "remote", 150000, 205000, "Collaboration", "https://webflow.com/careers"],
] as const;
const now = Math.floor(Date.now() / 1000);
export const previewJobs: JobDetail[] = examples.map(([company, title, location, workMode, min, max, department, url], index) => ({
  id: 900001 + index, company, companySlug: company.toLowerCase(), title, locationText: location,
  city: location.includes(",") ? location.split(",")[0] : null, region: null, countryCode: "US", workMode,
  department, employmentType: "Full-time", postedAt: now - index * 43200, sortAt: now - index * 43200,
  salaryMinAnnual: min, salaryMaxAnnual: max, salaryCurrency: "USD", expMinYears: index % 3 + 3,
  applyUrl: url, url, team: department, requisitionId: null, expMaxYears: null,
  excerpt: "Help build thoughtful tools that make meaningful work feel effortless.",
  description: `This is an example role for the Tallo design preview, not a verified opening. The application button opens ${company}’s careers page.\n\nWe believe the best products make complex things feel simple. We’re looking for a thoughtful builder to help shape experiences people love using every day.\n\nAs a ${title}, you’ll work closely with a small, collaborative team of engineers and designers. You’ll bring ideas from the first sketch to the final detail, with real ownership over the work you ship.\n\nWhat you’ll work on\n\n• Build intuitive, beautifully crafted product experiences.\n• Partner with design to turn ambitious ideas into reliable features.\n• Improve performance, accessibility, and the little details that matter.\n• Share your perspective and help the team do its best work.\n\nWhat you’ll bring\n\n• Experience building and shipping products for the web.\n• A strong eye for interaction design and product quality.\n• Clear communication and a collaborative approach to solving problems.\n• Curiosity, care, and a willingness to learn something new.\n\nRoom to do your best work\n\nWe value focused time, thoughtful feedback, and sustainable work. You’ll have the space to grow your craft and contribute to decisions that matter.`,
  facts: {},
}));
export function previewSearch(query: URLSearchParams): JobPage {
  const search = (query.get("q") ?? "").toLowerCase();
  return { jobs: previewJobs.filter(job => {
    if (search && !`${job.title} ${job.company} ${job.locationText} ${job.department}`.toLowerCase().includes(search)) return false;
    if (query.get("workMode") && job.workMode !== query.get("workMode")) return false;
    if (query.get("country") && job.countryCode !== query.get("country")?.toUpperCase()) return false;
    if (query.get("salaryMin") && (job.salaryMaxAnnual ?? 0) < Number(query.get("salaryMin"))) return false;
    if (query.get("maxExperience") && (job.expMinYears ?? 0) > Number(query.get("maxExperience"))) return false;
    if (query.get("postedWithinDays") && now - job.sortAt > Number(query.get("postedWithinDays")) * 86400) return false;
    return true;
  }), nextCursor: null };
}
