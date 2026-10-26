import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ago, number } from "@/lib/format";
import type { PlatformSummary } from "@/lib/status";

/** Collection time and freshness split per ATS. Unrecorded times render as a dash. */
export function PlatformTable({ platforms, now }: { platforms: PlatformSummary[]; now: number }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Platform</TableHead>
          <TableHead>Last collected</TableHead>
          <TableHead className="text-right">Sources</TableHead>
          <TableHead className="text-right">Never run</TableHead>
          <TableHead className="text-right">Fresh</TableHead>
          <TableHead className="text-right">Stale</TableHead>
          <TableHead className="text-right">Hidden</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {platforms.map((row) => (
          <TableRow key={row.platform}>
            <TableCell className="font-medium">{row.platform}</TableCell>
            <TableCell>
              {row.lastCollectedAt === null ? "—" : ago(row.lastCollectedAt, now)}
            </TableCell>
            <TableCell className="text-right tabular-nums">{number.format(row.total)}</TableCell>
            <TableCell className="text-right tabular-nums">
              {number.format(row.neverCollected)}
            </TableCell>
            <TableCell className="text-right tabular-nums">{number.format(row.fresh)}</TableCell>
            <TableCell className="text-right tabular-nums">{number.format(row.stale)}</TableCell>
            <TableCell className="text-right tabular-nums">{number.format(row.hidden)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
