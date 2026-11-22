import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SearchValues } from "@/lib/search";

/** A plain GET form: no script, the search runs when the browser loads the homepage. */
export function SearchForm({
  values,
  autoFocus = false,
}: {
  values: SearchValues;
  autoFocus?: boolean;
}) {
  return (
    <form action="/" method="get" className="search-form" aria-label="Find jobs">
      <div className="search-field">
        <label htmlFor="search-title" className="text-sm font-medium">
          Job title
        </label>
        <Input
          id="search-title"
          name="title"
          defaultValue={values.title}
          placeholder="e.g. Software engineer"
          aria-describedby="search-help"
          autoFocus={autoFocus}
        />
      </div>
      <div className="search-field">
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
      <div className="search-field">
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
      <div className="search-field">
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
      <div className="search-field">
        <label htmlFor="search-posted" className="text-sm font-medium">
          Posted <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <select
          id="search-posted"
          name="postedWithin"
          defaultValue={values.postedWithin}
          className="search-select"
        >
          <option value="">Any time</option>
          <option value="1">Last 24 hours</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </select>
      </div>
      <div className="search-field">
        <label htmlFor="search-sort" className="text-sm font-medium">
          Sort
        </label>
        <select
          id="search-sort"
          name="sort"
          defaultValue={values.sort || "relevance"}
          className="search-select"
        >
          <option value="relevance">Best match</option>
          <option value="recent">Newest first</option>
        </select>
      </div>
      <div className="search-actions">
        <p id="search-help">
          A title or a company is required. Separate multiple values with commas.
        </p>
        <Button type="submit">
          Search <span aria-hidden="true">→</span>
        </Button>
      </div>
    </form>
  );
}
