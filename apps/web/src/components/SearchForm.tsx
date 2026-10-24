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

const activeFilters = (values: Record<string, string>) =>
  Object.entries(values).some(([name, value]) => value !== "" && name !== "q" && name !== "cursor");

/** A plain GET form: the URL is the state, so there is nothing to hydrate. */
export function SearchForm({ values }: { values: Record<string, string> }) {
  const v = (name: string) => values[name] ?? "";
  return (
    <form
      method="get"
      aria-label="Job search filters"
      className="rounded-xl border border-border bg-card p-4 shadow-sm"
    >
      <div className="grid gap-3">
        <Input
          name="q"
          defaultValue={v("q")}
          placeholder="Title, company or place"
          aria-label="Search"
          className="font-medium sm:text-base"
          autoFocus
        />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <NativeSelect name="workMode" defaultValue={v("workMode")} aria-label="Work mode">
            <NativeSelectOption value="">Any work mode</NativeSelectOption>
            {WORK_MODES.map((mode) => (
              <NativeSelectOption key={mode} value={mode}>
                {mode}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <NativeSelect
            name="postedWithinDays"
            defaultValue={v("postedWithinDays")}
            aria-label="Posted"
          >
            <NativeSelectOption value="">Any time</NativeSelectOption>
            {POSTED.map(({ value, label }) => (
              <NativeSelectOption key={value} value={value}>
                {label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Input
            name="country"
            defaultValue={v("country")}
            placeholder="Country (US)"
            maxLength={2}
            aria-label="Country"
          />
        </div>
        {/* Advanced filters keep collapsed without any client JS: plain details/summary. */}
        <details className="group">
          <summary className="flex w-fit cursor-pointer select-none list-none items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
            <span
              aria-hidden="true"
              className="grid size-4 place-items-center rounded-sm border border-border text-xs leading-none transition-transform group-open:rotate-45"
            >
              +
            </span>
            {activeFilters(values) ? "More filters · active" : "More filters"}
          </summary>
          <div className="grid gap-3 pt-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="salaryMin">Minimum pay / yr</Label>
              <Input
                id="salaryMin"
                name="salaryMin"
                defaultValue={v("salaryMin")}
                inputMode="numeric"
                placeholder="90000"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="maxExperience">Max years required</Label>
              <Input
                id="maxExperience"
                name="maxExperience"
                defaultValue={v("maxExperience")}
                inputMode="numeric"
                placeholder="5"
              />
            </div>
            <label className="flex items-center gap-2 pt-1 text-sm text-muted-foreground">
              <input
                type="checkbox"
                name="all"
                value="true"
                defaultChecked={v("all") === "true"}
                className="size-4 rounded accent-primary"
              />
              Include hidden
            </label>
          </div>
        </details>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
        <Button type="submit" size="sm">
          Search
        </Button>
        {activeFilters(values) && (
          <Button variant="ghost" size="sm" asChild>
            <a href="/">Clear</a>
          </Button>
        )}
        <span className="ml-auto text-xs text-muted-foreground">Saved in the URL — shareable</span>
      </div>
    </form>
  );
}
