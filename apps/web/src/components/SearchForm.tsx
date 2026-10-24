import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

const WORK_MODES = ["remote", "hybrid", "onsite"];
const POSTED = ["1", "7", "30"];

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

/**
 * A plain GET form: the URL is the state, so there is nothing to hydrate.
 * Laid out as a filter rail: search on top, filters in two columns, then
 * actions. Narrow enough to share space with results on desktop.
 */
export function SearchForm({ values }: { values: Record<string, string> }) {
  const v = (name: string) => values[name] ?? "";
  const active = activeFilters(values);
  return (
    <form
      method="get"
      aria-label="Job search filters"
      className="grid gap-3 rounded-lg border border-border bg-card p-4"
    >
      <div className="grid gap-1.5">
        <Label htmlFor="q" className="text-xs font-normal text-muted-foreground">
          Search
        </Label>
        <Input
          id="q"
          name="q"
          defaultValue={v("q")}
          placeholder="Title, company or place"
          className="h-9"
          autoFocus
        />
      </div>

      <div className="grid grid-cols-2 gap-2.5">
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
            {POSTED.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {value === "1" ? "24 hours" : `${value} days`}
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
            Min pay
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

      {/* Rarely-used filters collapse with native details/summary: no client JS. */}
      <details className="group min-w-0">
        <summary className="flex cursor-pointer select-none list-none items-center justify-between rounded-md text-xs font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
          <span>
            Max years
            {active > 0 && <span className="text-primary">{` (${active})`}</span>}
          </span>
          <span
            aria-hidden="true"
            className="text-base leading-none transition-transform group-open:rotate-45"
          >
            +
          </span>
        </summary>
        <div className="grid gap-2 pt-3">
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

      <div className="mt-1 flex items-center gap-2 border-t border-border pt-3">
        <Button type="submit" size="sm" className="flex-1">
          Search
        </Button>
        {active > 0 && (
          <Button
            variant="ghost"
            size="sm"
            asChild
            className="h-8 text-muted-foreground hover:text-foreground"
          >
            <a href="/">Clear</a>
          </Button>
        )}
      </div>
    </form>
  );
}
