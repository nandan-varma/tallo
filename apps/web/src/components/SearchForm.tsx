import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

const WORK_MODES = ["remote", "hybrid", "onsite"];
const POSTED = [
  { value: "1", label: "Last 24 hours" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
];

/** A plain GET form: the URL is the state, so there is nothing to hydrate. */
export function SearchForm({ values }: { values: Record<string, string> }) {
  const v = (name: string) => values[name] ?? "";
  return (
    <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Input
        name="q"
        defaultValue={v("q")}
        placeholder="Title, company or place"
        aria-label="Search"
        className="sm:col-span-2 lg:col-span-4"
        autoFocus
      />
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
      <Input
        name="salaryMin"
        defaultValue={v("salaryMin")}
        placeholder="Min pay / yr"
        inputMode="numeric"
        aria-label="Minimum pay"
      />
      <Input
        name="maxExperience"
        defaultValue={v("maxExperience")}
        placeholder="Max years required"
        inputMode="numeric"
        aria-label="Maximum years required"
      />
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          name="all"
          value="true"
          defaultChecked={v("all") === "true"}
          className="size-4 accent-primary"
        />
        Include hidden
      </label>
      <Button type="submit" className="sm:col-span-2 lg:col-span-1 lg:justify-self-end">
        Search
      </Button>
    </form>
  );
}
