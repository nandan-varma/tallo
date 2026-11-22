import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
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
    <form action="/" method="get" className="grid gap-5 sm:grid-cols-2" aria-label="Find jobs">
      <div className="grid min-w-0 gap-2">
        <Label htmlFor="search-title" className="text-sm font-medium">
          Job title
        </Label>
        <Input
          id="search-title"
          name="title"
          defaultValue={values.title}
          placeholder="e.g. Software engineer"
          aria-describedby="search-help"
          autoFocus={autoFocus}
        />
      </div>
      <div className="grid min-w-0 gap-2">
        <Label htmlFor="search-company" className="text-sm font-medium">
          Company
        </Label>
        <Input
          id="search-company"
          name="company"
          defaultValue={values.company}
          placeholder="Stripe"
        />
      </div>
      <div className="grid min-w-0 gap-2">
        <Label htmlFor="search-location" className="text-sm font-medium">
          Location
        </Label>
        <Input
          id="search-location"
          name="location"
          defaultValue={values.location}
          placeholder="Seattle, remote"
        />
      </div>
      <div className="grid min-w-0 gap-2">
        <Label htmlFor="search-country" className="text-sm font-medium">
          Country
        </Label>
        <Input
          id="search-country"
          name="country"
          defaultValue={values.country}
          placeholder="US, CA"
        />
      </div>
      <div className="grid min-w-0 gap-2">
        <Label htmlFor="search-posted" className="text-sm font-medium">
          Posted
        </Label>
        <NativeSelect
          id="search-posted"
          name="postedWithin"
          defaultValue={values.postedWithin}
          className="w-full"
        >
          <NativeSelectOption value="">Any time</NativeSelectOption>
          <NativeSelectOption value="1">Last 24 hours</NativeSelectOption>
          <NativeSelectOption value="7">Last 7 days</NativeSelectOption>
          <NativeSelectOption value="30">Last 30 days</NativeSelectOption>
          <NativeSelectOption value="90">Last 90 days</NativeSelectOption>
        </NativeSelect>
      </div>
      <div className="grid min-w-0 gap-2">
        <Label htmlFor="search-sort" className="text-sm font-medium">
          Sort
        </Label>
        <NativeSelect
          id="search-sort"
          name="sort"
          defaultValue={values.sort || "relevance"}
          className="w-full"
        >
          <NativeSelectOption value="relevance">Best match</NativeSelectOption>
          <NativeSelectOption value="recent">Newest first</NativeSelectOption>
        </NativeSelect>
      </div>
      <div className="flex flex-col gap-3 sm:col-span-2 sm:flex-row sm:items-center sm:justify-between">
        <p id="search-help" className="text-xs text-muted-foreground">
          A title or a company is required.
        </p>
        <Button type="submit">Search</Button>
      </div>
    </form>
  );
}
