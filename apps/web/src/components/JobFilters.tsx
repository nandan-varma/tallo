import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function FilterSelect({
  name,
  label,
  initialValue,
  options,
  customLabel,
}: {
  name: string;
  label: string;
  initialValue: string;
  options: [string, string][];
  customLabel: (value: string) => string;
}) {
  const id = useId();
  const [value, setValue] = useState(initialValue || "any");
  const choices: [string, string][] =
    initialValue && !options.some(([key]) => key === initialValue)
      ? [...options, [initialValue, customLabel(initialValue)]]
      : options;
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <input type="hidden" name={name} value={value === "any" ? "" : value} />
      <Select value={value} onValueChange={setValue}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          <SelectGroup>
            {choices.map(([key, text]) => (
              <SelectItem key={key} value={key}>
                {text}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}

export function JobFilters({ values }: { values: Record<string, string> }) {
  const id = useId();
  const [workMode, setWorkMode] = useState(values.workMode || "any");
  return (
    <form method="get" className="grid gap-6">
      {values.q && <input type="hidden" name="q" value={values.q} />}
      <fieldset className="grid gap-3">
        <legend className="mb-3 text-sm font-medium">Work arrangement</legend>
        <input type="hidden" name="workMode" value={workMode === "any" ? "" : workMode} />
        <RadioGroup value={workMode} onValueChange={setWorkMode} className="gap-0">
          {[
            ["any", "Any arrangement"],
            ["remote", "Remote"],
            ["hybrid", "Hybrid"],
            ["onsite", "On-site"],
          ].map(([value, label]) => (
            <div key={value} className="flex min-h-9 items-center gap-2.5">
              <RadioGroupItem value={value} id={`${id}-${value}`} />
              <Label
                htmlFor={`${id}-${value}`}
                className="flex-1 cursor-pointer py-2 font-normal text-muted-foreground"
              >
                {label}
              </Label>
            </div>
          ))}
        </RadioGroup>
      </fieldset>
      <FilterSelect
        name="postedWithinDays"
        customLabel={(value) => `Past ${value} days`}
        label="Date posted"
        initialValue={values.postedWithinDays ?? ""}
        options={[
          ["any", "Any time"],
          ["1", "Past 24 hours"],
          ["7", "Past week"],
          ["30", "Past month"],
        ]}
      />
      <FilterSelect
        name="salaryMin"
        customLabel={(value) => `$${Number(value).toLocaleString("en-US")}+`}
        label="Minimum annual salary"
        initialValue={values.salaryMin ?? ""}
        options={[
          ["any", "Any salary"],
          ["80000", "$80,000+"],
          ["120000", "$120,000+"],
          ["160000", "$160,000+"],
          ["200000", "$200,000+"],
        ]}
      />
      <details
        className="group"
        open={Boolean(values.country || values.maxExperience || values.all)}
      >
        <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between text-sm font-medium [&::-webkit-details-marker]:hidden">
          More filters
          <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-4 grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor={`${id}-country`}>Country code</Label>
            <Input
              id={`${id}-country`}
              name="country"
              maxLength={2}
              placeholder="US"
              defaultValue={values.country ?? ""}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`${id}-experience`}>Maximum experience</Label>
            <Input
              id={`${id}-experience`}
              type="number"
              min="0"
              name="maxExperience"
              placeholder="Years"
              defaultValue={values.maxExperience ?? ""}
            />
          </div>
          <div className="flex min-h-9 items-center gap-2.5">
            <Checkbox
              id={`${id}-hidden`}
              name="all"
              value="true"
              defaultChecked={values.all === "true"}
            />
            <Label className="cursor-pointer font-normal" htmlFor={`${id}-hidden`}>
              Include hidden jobs
            </Label>
          </div>
        </div>
      </details>
      <Button type="submit" className="w-full">
        Apply filters
      </Button>
    </form>
  );
}
