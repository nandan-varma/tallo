import { FreshnessBadge } from "@/components/FreshnessBadge";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ago } from "@/lib/format";
import type { SourceRecord } from "@/lib/status";

/** Sources that need attention. Unrecorded times render as a dash, never as an invented value. */
export function SourceHealthTable({ sources, now }: { sources: SourceRecord[]; now: number }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Source</TableHead>
          <TableHead>Last collected</TableHead>
          <TableHead>Last full listing</TableHead>
          <TableHead>Freshness</TableHead>
          <TableHead>Latest run</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sources.map((source) => (
          <TableRow key={source.id}>
            <TableCell>
              <div className="font-medium">{source.company}</div>
              <div className="text-xs text-muted-foreground">
                {source.platform} · {source.key}
              </div>
            </TableCell>
            <TableCell>{source.lastRunAt === null ? "—" : ago(source.lastRunAt, now)}</TableCell>
            <TableCell>
              {source.lastCompleteRunAt === null ? "—" : ago(source.lastCompleteRunAt, now)}
            </TableCell>
            <TableCell>
              <FreshnessBadge freshness={source.freshness} />
            </TableCell>
            <TableCell>
              {source.lastStatus && (
                <Badge variant={source.lastStatus === "partial" ? "destructive" : "outline"}>
                  {source.lastStatus}
                </Badge>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
