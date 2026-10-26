import { APPLICATION_STATUSES, type ApplicationStatus } from "@tallo/contracts";
import { Bookmark, Check, ChevronDown, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/tracker";
import { cn } from "@/lib/utils";

/**
 * Where a role stands. Untracked it is a "Save" button; tracked it shows the status and opens the other
 * ones. This menu is the only way to change a status, from the posting or from the tracker list.
 */
export function StatusMenu({
  status,
  onSet,
  onRemove,
  size = "sm",
}: {
  status: ApplicationStatus | undefined;
  onSet: (status: ApplicationStatus) => void;
  onRemove: () => void;
  size?: "sm" | "xs";
}) {
  if (!status) {
    return (
      <Button
        type="button"
        variant="outline"
        size={size}
        onClick={() => onSet("saved")}
        className="gap-1.5"
      >
        <Bookmark aria-hidden />
        Save
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={size}
          aria-label={`Status: ${STATUS_LABEL[status]}. Change`}
          className={cn("gap-1", STATUS_TONE[status], "hover:opacity-80")}
        >
          {STATUS_LABEL[status]}
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {APPLICATION_STATUSES.map((option) => (
          <DropdownMenuItem key={option} onSelect={() => onSet(option)}>
            {STATUS_LABEL[option]}
            {option === status && <Check className="ml-auto" aria-hidden />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onRemove}>
          <Trash2 aria-hidden />
          Stop tracking
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
