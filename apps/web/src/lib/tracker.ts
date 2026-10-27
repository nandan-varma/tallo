import type { Application, ApplicationStatus } from "@tallo/contracts";
import { APPLICATION_STATUSES } from "@tallo/contracts";

export const STATUS_LABEL: Record<ApplicationStatus, string> = {
  saved: "Saved",
  applied: "Applied",
  interviewing: "Interviewing",
  offer: "Offer",
  rejected: "Rejected",
};

/** Badge colors, from quiet (saved) to loud (offer); rejected is muted again. */
export const STATUS_TONE: Record<ApplicationStatus, string> = {
  saved: "bg-muted text-muted-foreground",
  applied: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  interviewing: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  offer: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  rejected: "bg-muted text-muted-foreground line-through",
};

export type StatusFilter = ApplicationStatus | "all";

/** How many roles are in each status, plus `all`. Every status is present, so the filter bar never jumps. */
export function countByStatus(applications: Application[]): Record<StatusFilter, number> {
  const counts = { all: applications.length } as Record<StatusFilter, number>;
  for (const status of APPLICATION_STATUSES) {
    counts[status] = applications.filter((application) => application.status === status).length;
  }
  return counts;
}

export function filterByStatus(applications: Application[], filter: StatusFilter): Application[] {
  return filter === "all"
    ? applications
    : applications.filter((application) => application.status === filter);
}

const WEEK = 7 * 86_400;

/** An application a week old with no later status: time to follow up. */
export function needsFollowUp(application: Application, now = Date.now() / 1000): boolean {
  return (
    application.status === "applied" &&
    application.appliedAt !== null &&
    now - application.updatedAt >= WEEK
  );
}

/** What clicking "Apply" means for the tracker: a role not yet applied to is now applied to. */
export function afterApplyClick(current: ApplicationStatus | undefined): ApplicationStatus | null {
  return current === undefined || current === "saved" ? "applied" : null;
}
