import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { httpsUrl, type RunRecord, runCounts, since } from "@/lib/status";

const MAX_ISSUES_SHOWN = 3;

/** Recent runs that ended partial or reported issues. Unmeasured counts are omitted. */
export function RunIssuesTable({
  runs,
  names,
  now,
}: {
  runs: RunRecord[];
  /** Source id to company name, for readable rows. Falls back to the id. */
  names: Record<string, string>;
  now: number;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Source</TableHead>
          <TableHead>Run</TableHead>
          <TableHead>Counts</TableHead>
          <TableHead>Issues</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => {
          const issues = run.issues ?? [];
          return (
            <TableRow key={run.id}>
              <TableCell className="align-top">
                <div className="font-medium">{names[run.sourceId] ?? run.sourceId}</div>
                <div className="text-xs text-muted-foreground">{run.runnerId}</div>
              </TableCell>
              <TableCell className="align-top">
                <Badge variant={run.status === "partial" ? "destructive" : "outline"}>
                  {run.status}
                </Badge>
                <div className="mt-1 text-xs text-muted-foreground">
                  {since(run.startedAt, now)}
                </div>
              </TableCell>
              <TableCell className="align-top text-xs text-muted-foreground">
                {runCounts(run)
                  .map((c) => `${c.value} ${c.label}`)
                  .join(" · ") || "—"}
              </TableCell>
              <TableCell className="align-top whitespace-normal">
                {issues.length === 0 ? (
                  <span className="text-muted-foreground">None recorded</span>
                ) : (
                  <ul className="grid gap-1">
                    {issues.slice(0, MAX_ISSUES_SHOWN).map((issue, i) => (
                      <li key={i} className="flex flex-wrap items-baseline gap-1.5">
                        <Badge variant="outline">{issue.code}</Badge>
                        <span className="break-words">{issue.message}</span>
                        {httpsUrl(issue.url) && (
                          <a
                            href={httpsUrl(issue.url)}
                            rel="noreferrer noopener"
                            className="text-xs text-muted-foreground underline underline-offset-4"
                          >
                            source
                          </a>
                        )}
                      </li>
                    ))}
                    {issues.length > MAX_ISSUES_SHOWN && (
                      <li className="text-xs text-muted-foreground">
                        +{issues.length - MAX_ISSUES_SHOWN} more
                      </li>
                    )}
                  </ul>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
