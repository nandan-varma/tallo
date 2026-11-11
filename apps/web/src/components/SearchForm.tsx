import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SearchValues } from "@/lib/search";

/** A plain GET form: no script, the search runs when the browser loads `/search`. */
export function SearchForm({
  values,
  autoFocus = false,
}: {
  values: SearchValues;
  autoFocus?: boolean;
}) {
  return (
    <form
      action="/search"
      method="get"
      className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end"
    >
      <div className="grid gap-1.5">
        <label htmlFor="search-title" className="text-sm font-medium">
          Job title
        </label>
        <Input
          id="search-title"
          name="title"
          defaultValue={values.title}
          placeholder="backend engineer, platform engineer"
          required
          autoFocus={autoFocus}
        />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="search-company" className="text-sm font-medium">
          Company <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <Input
          id="search-company"
          name="company"
          defaultValue={values.company}
          placeholder="Stripe"
        />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="search-location" className="text-sm font-medium">
          Location <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <Input
          id="search-location"
          name="location"
          defaultValue={values.location}
          placeholder="Seattle, remote"
        />
      </div>
      <Button type="submit">Search</Button>
    </form>
  );
}
