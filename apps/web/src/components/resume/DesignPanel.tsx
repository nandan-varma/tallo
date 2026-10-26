import type { ResumeStyle } from "@tallo/contracts";
import { cn } from "@/lib/utils";

const ACCENTS = ["#1f2937", "#1d4ed8", "#0f766e", "#b45309", "#be123c", "#6d28d9"];

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          // biome-ignore lint/a11y/useSemanticElements: a segmented button inside a radiogroup
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-lg border px-3 py-1.5 text-left text-sm transition-colors hover:bg-muted",
              value === option.value && "border-foreground bg-muted font-medium",
            )}
          >
            {option.label}
            {option.hint && (
              <span className="block text-xs font-normal text-muted-foreground">{option.hint}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/** How the PDF is drawn. The layout shrinks to fit the page limit, so these never change the words. */
export function DesignPanel({
  style,
  onStyle,
}: {
  style: ResumeStyle;
  onStyle: (patch: Partial<ResumeStyle>) => void;
}) {
  return (
    <div className="grid gap-4">
      <Choice
        label="Template"
        value={style.template}
        options={[
          { value: "classic", label: "Classic", hint: "Serif, centered" },
          { value: "modern", label: "Modern", hint: "Sans, accent color" },
        ]}
        onChange={(template) => onStyle({ template })}
      />
      <Choice
        label="Page limit"
        value={String(style.pages)}
        options={[
          { value: "1", label: "1 page" },
          { value: "2", label: "2 pages" },
        ]}
        onChange={(pages) => onStyle({ pages: Number(pages) })}
      />
      <Choice
        label="Paper"
        value={style.paper}
        options={[
          { value: "letter", label: "US Letter" },
          { value: "a4", label: "A4" },
        ]}
        onChange={(paper) => onStyle({ paper })}
      />
      {style.template === "modern" && (
        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Accent</span>
          <div className="flex gap-2" role="radiogroup" aria-label="Accent color">
            {ACCENTS.map((color) => (
              // biome-ignore lint/a11y/useSemanticElements: a color swatch button inside a radiogroup
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={style.accent === color}
                aria-label={color}
                onClick={() => onStyle({ accent: color })}
                className={cn(
                  "size-7 rounded-full border-2 border-background ring-1 ring-border transition-shadow",
                  style.accent === color && "ring-2 ring-foreground",
                )}
                style={{ background: color }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
