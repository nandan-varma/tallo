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
    <form action="/search" method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div className="grid gap-1.5">
        <label htmlFor="search-title" className="text-sm font-medium">
          Job title
        </label>
        <Input
          id="search-title"
          name="title"
          defaultValue={values.title}
          placeholder="backend engineer, platform engineer"
          autoFocus={autoFocus}
        />
        <p className="text-xs text-muted-foreground">A title or a company is required.</p>
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
      <div className="grid gap-1.5">
        <label htmlFor="search-country" className="text-sm font-medium">
          Country <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <Input
          id="search-country"
          name="country"
          defaultValue={values.country}
          placeholder="US, CA"
        />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="search-posted" className="text-sm font-medium">
          Posted <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <select
          id="search-posted"
          name="postedWithin"
          defaultValue={values.postedWithin}
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs"
        >
          <option value="">Any time</option>
          <option value="1">Last 24 hours</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </select>
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="search-sort" className="text-sm font-medium">
          Sort
        </label>
        <select
          id="search-sort"
          name="sort"
          defaultValue={values.sort || "relevance"}
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs"
        >
          <option value="relevance">Best match</option>
          <option value="recent">Newest first</option>
        </select>
      </div>
      <Button type="submit">Search</Button>
    </form>
  );
}
