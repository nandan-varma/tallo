import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

const WORK_MODES = ["remote", "hybrid", "onsite"];
const POSTED = [
  { value: "1", label: "Last 24 hours" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
];

const FILTER_KEYS = [
  "workMode",
  "postedWithinDays",
  "country",
  "salaryMin",
  "maxExperience",
  "all",
];

const activeFilters = (values: Record<string, string>) =>
  FILTER_KEYS.filter((name) => values[name] && values[name] !== "").length;

/** A plain GET form: the URL is the state, so there is nothing to hydrate. */
export function SearchForm({ values }: { values: Record<string, string> }) {
  const v = (name: string) => values[name] ?? "";
  const active = activeFilters(values);
  return (
    <form
      method="get"
      aria-label="Job search filters"
      className="rounded-lg border border-border bg-card p-4 sm:p-5"
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        {/* Primary search: the only field that needs no label above it. */}
        <div className="grid gap-1.5">
          <Label htmlFor="q" className="sr-only">
            Search jobs
          </Label>
          <Input
            id="q"
            name="q"
            defaultValue={v("q")}
            placeholder="Title, company or place"
            className="h-9 font-medium sm:text-base"
            autoFocus
          />
        </div>
        <div className="flex gap-2">
          <Button type="submit" size="sm" className="h-9 sm:px-8">
            Search
          </Button>
          {active > 0 && (
            <Button variant="ghost" size="sm" asChild className="h-9 text-muted-foreground">
              <a href="/">Clear</a>
            </Button>
          )}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="grid gap-1">
          <Label htmlFor="workMode" className="text-xs font-normal text-muted-foreground">
            Work mode
          </Label>
          <NativeSelect
            id="workMode"
            name="workMode"
            defaultValue={v("workMode")}
            className="h-9 text-sm"
          >
            <NativeSelectOption value="">Any</NativeSelectOption>
            {WORK_MODES.map((mode) => (
              <NativeSelectOption key={mode} value={mode} className="capitalize">
                {mode}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="postedWithinDays" className="text-xs font-normal text-muted-foreground">
            Posted
          </Label>
          <NativeSelect
            id="postedWithinDays"
            name="postedWithinDays"
            defaultValue={v("postedWithinDays")}
            className="h-9 text-sm"
          >
            <NativeSelectOption value="">Any time</NativeSelectOption>
            {POSTED.map(({ value, label }) => (
              <NativeSelectOption key={value} value={value}>
                {label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="country" className="text-xs font-normal text-muted-foreground">
            Country
          </Label>
          <Input
            id="country"
            name="country"
            defaultValue={v("country")}
            placeholder="US"
            maxLength={2}
            className="h-9 text-sm"
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="salaryMin" className="text-xs font-normal text-muted-foreground">
            Min pay / yr
          </Label>
          <Input
            id="salaryMin"
            name="salaryMin"
            defaultValue={v("salaryMin")}
            inputMode="numeric"
            placeholder="90000"
            className="h-9 text-sm tabular-nums"
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border pt-3">
        {/* Advanced filters collapse with native details/summary: no client JS. */}
        <details className="group min-w-0">
          <summary className="flex cursor-pointer select-none list-none items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
            <span
              aria-hidden="true"
              className="text-base leading-none transition-transform group-open:rotate-45"
            >
              +
            </span>
            Max years{active > 0 ? ` · ${active} filter${active === 1 ? "" : "s"} on` : ""}
          </summary>
          <div className="grid gap-1.5 pt-3 sm:w-56">
            <Input
              id="maxExperience"
              name="maxExperience"
              defaultValue={v("maxExperience")}
              inputMode="numeric"
              placeholder="Max years required"
              aria-label="Max years required"
              className="h-9 text-sm"
            />
          </div>
        </details>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            name="all"
            value="true"
            defaultChecked={v("all") === "true"}
            className="size-3.5 rounded accent-primary"
          />
          Include hidden jobs
        </label>
      </div>
    </form>
  );
}
