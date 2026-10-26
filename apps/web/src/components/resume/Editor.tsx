import type { Resume, ResumeStyle } from "@tallo/contracts";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  AddButton,
  AreaField,
  BulletList,
  EntryCard,
  Section,
  TextField,
} from "@/components/resume/fields";
import { Button } from "@/components/ui/button";
import { blank, move, removeAt, replaceAt, splitItems } from "@/lib/resume/edit";
import { cn } from "@/lib/utils";

export const SECTIONS = [
  { id: "contact", label: "Contact" },
  { id: "summary", label: "Summary" },
  { id: "experience", label: "Experience" },
  { id: "projects", label: "Projects" },
  { id: "education", label: "Education" },
  { id: "skills", label: "Skills" },
  { id: "extras", label: "More" },
  { id: "design", label: "Design" },
] as const;

const ACCENTS = ["#1f2937", "#1d4ed8", "#0f766e", "#b45309", "#be123c", "#6d28d9"];

type Update<K extends keyof Resume> = (items: Resume[K]) => void;

/** `a · b` for the folded header of an entry; empty parts are skipped. */
const join = (...parts: string[]) => parts.filter(Boolean).join(" · ");
const span = (item: { start: string; end: string }) =>
  [item.start, item.end].filter(Boolean).join(" – ");

/** A repeating block: entries as cards the person can fold, reorder and remove, then an add button. */
function Entries<T>({
  items,
  onChange,
  title,
  subtitle,
  fresh,
  addLabel,
  children,
}: {
  items: T[];
  onChange: (items: T[]) => void;
  title: (item: T) => string;
  subtitle: (item: T) => string;
  fresh: () => T;
  addLabel: string;
  children: (item: T, set: (item: T) => void) => React.ReactNode;
}) {
  return (
    <div className="grid gap-2.5">
      {items.map((item, index) => (
        <EntryCard
          // An entry has no identity beyond its place in the list.
          key={index}
          index={index}
          count={items.length}
          title={title(item)}
          subtitle={subtitle(item)}
          defaultOpen={items.length <= 3 || index === 0}
          onMove={(to) => onChange(move(items, index, to))}
          onRemove={() => onChange(removeAt(items, index))}
        >
          {children(item, (next) => onChange(replaceAt(items, index, next)))}
        </EntryCard>
      ))}
      <AddButton onClick={() => onChange([...items, fresh()])}>{addLabel}</AddButton>
    </div>
  );
}

function Dates({
  item,
  set,
}: {
  item: { start: string; end: string };
  set: (next: { start: string; end: string }) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <TextField
        label="Start"
        value={item.start}
        placeholder="Jun 2021"
        onChange={(start) => set({ ...item, start })}
      />
      <TextField
        label="End"
        value={item.end}
        placeholder="Present"
        onChange={(end) => set({ ...item, end })}
      />
    </div>
  );
}

export function Editor({
  resume,
  style,
  onResume,
  onStyle,
}: {
  resume: Resume;
  style: ResumeStyle;
  onResume: (change: (resume: Resume) => Resume) => void;
  onStyle: (patch: Partial<ResumeStyle>) => void;
}) {
  const field = <K extends keyof Resume>(key: K) => ({
    value: resume[key] as string,
    onChange: (value: string) => onResume((r) => ({ ...r, [key]: value })),
  });
  const list =
    <K extends keyof Resume>(key: K): Update<K> =>
    (items) =>
      onResume((r) => ({ ...r, [key]: items }));

  return (
    <div className="grid gap-9">
      <Section id="contact" title="Contact">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Full name" autoComplete="name" {...field("name")} />
          <TextField
            label="Headline"
            placeholder="Senior Backend Engineer"
            {...field("headline")}
          />
          <TextField label="Email" type="email" autoComplete="email" {...field("email")} />
          <TextField label="Phone" type="tel" autoComplete="tel" {...field("phone")} />
          <TextField
            label="Location"
            placeholder="Austin, TX"
            className="sm:col-span-2"
            {...field("location")}
          />
        </div>
        <div className="grid gap-2">
          <span className="text-xs font-medium text-muted-foreground">Links</span>
          {resume.links.map((link, index) => (
            <div
              // A link has no identity beyond its place in the list.
              key={index}
              className="flex items-end gap-2"
            >
              <TextField
                label="Label"
                value={link.label}
                placeholder="GitHub"
                className="w-28 shrink-0"
                onChange={(label) =>
                  list("links")(replaceAt(resume.links, index, { ...link, label }))
                }
              />
              <TextField
                label="Address"
                value={link.url}
                placeholder="github.com/ada"
                className="min-w-0 flex-1"
                onChange={(url) => list("links")(replaceAt(resume.links, index, { ...link, url }))}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove link ${index + 1}`}
                onClick={() => list("links")(removeAt(resume.links, index))}
              >
                <X />
              </Button>
            </div>
          ))}
          <AddButton onClick={() => list("links")([...resume.links, blank.link()])}>
            Add link
          </AddButton>
        </div>
      </Section>

      <Section
        id="summary"
        title="Summary"
        hint="Two or three sentences. Leave it empty to leave it out."
      >
        <AreaField label="Summary" rows={3} {...field("summary")} />
      </Section>

      <Section
        id="experience"
        title="Experience"
        hint="Most recent first. Press Enter to add a bullet."
      >
        <Entries
          items={resume.experience}
          onChange={list("experience")}
          fresh={blank.experience}
          addLabel="Add role"
          title={(job) => job.title || job.company}
          subtitle={(job) => join(job.title ? job.company : "", span(job))}
        >
          {(job, set) => (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField
                  label="Title"
                  value={job.title}
                  onChange={(title) => set({ ...job, title })}
                />
                <TextField
                  label="Company"
                  value={job.company}
                  onChange={(company) => set({ ...job, company })}
                />
              </div>
              <TextField
                label="Location"
                value={job.location}
                onChange={(location) => set({ ...job, location })}
              />
              <Dates item={job} set={(dates) => set({ ...job, ...dates })} />
              <BulletList
                label="Bullets"
                items={job.bullets}
                placeholder="What you did, and what came of it"
                onChange={(bullets) => set({ ...job, bullets })}
              />
            </>
          )}
        </Entries>
      </Section>

      <Section id="projects" title="Projects">
        <Entries
          items={resume.projects}
          onChange={list("projects")}
          fresh={blank.project}
          addLabel="Add project"
          title={(project) => project.name}
          subtitle={(project) => project.url}
        >
          {(project, set) => (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField
                  label="Name"
                  value={project.name}
                  onChange={(name) => set({ ...project, name })}
                />
                <TextField
                  label="Link"
                  value={project.url}
                  placeholder="github.com/ada/engine"
                  onChange={(url) => set({ ...project, url })}
                />
              </div>
              <BulletList
                label="Bullets"
                items={project.bullets}
                onChange={(bullets) => set({ ...project, bullets })}
              />
            </>
          )}
        </Entries>
      </Section>

      <Section id="education" title="Education">
        <Entries
          items={resume.education}
          onChange={list("education")}
          fresh={blank.education}
          addLabel="Add school"
          title={(school) => school.school || school.degree}
          subtitle={(school) => join(school.school ? school.degree : "", span(school))}
        >
          {(school, set) => (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField
                  label="School"
                  value={school.school}
                  onChange={(value) => set({ ...school, school: value })}
                />
                <TextField
                  label="Degree"
                  value={school.degree}
                  onChange={(degree) => set({ ...school, degree })}
                />
              </div>
              <TextField
                label="Location"
                value={school.location}
                onChange={(location) => set({ ...school, location })}
              />
              <Dates item={school} set={(dates) => set({ ...school, ...dates })} />
              <BulletList
                label="Details"
                items={school.details}
                addLabel="Add detail"
                placeholder="Honors, thesis, relevant courses"
                onChange={(details) => set({ ...school, details })}
              />
            </>
          )}
        </Entries>
      </Section>

      <Section id="skills" title="Skills" hint="Separate skills with commas.">
        <div className="grid gap-2.5">
          {resume.skills.map((group, index) => (
            <div
              // A skill group has no identity beyond its place in the list.
              key={index}
              className="flex items-end gap-2"
            >
              <TextField
                label="Group"
                value={group.label}
                placeholder="Languages"
                className="w-32 shrink-0"
                onChange={(label) =>
                  list("skills")(replaceAt(resume.skills, index, { ...group, label }))
                }
              />
              <SkillItems
                items={group.items}
                onChange={(items) =>
                  list("skills")(replaceAt(resume.skills, index, { ...group, items }))
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove skill group ${group.label || index + 1}`}
                onClick={() => list("skills")(removeAt(resume.skills, index))}
              >
                <X />
              </Button>
            </div>
          ))}
          <AddButton onClick={() => list("skills")([...resume.skills, blank.skill()])}>
            Add group
          </AddButton>
        </div>
      </Section>

      <Section
        id="extras"
        title="More sections"
        hint="Certifications, awards, publications, volunteering."
      >
        <Entries
          items={resume.extras}
          onChange={list("extras")}
          fresh={blank.extra}
          addLabel="Add section"
          title={(extra) => extra.title}
          subtitle={(extra) => `${extra.items.filter(Boolean).length} items`}
        >
          {(extra, set) => (
            <>
              <TextField
                label="Section title"
                value={extra.title}
                placeholder="Certifications"
                onChange={(title) => set({ ...extra, title })}
              />
              <BulletList
                label="Items"
                items={extra.items}
                addLabel="Add item"
                onChange={(items) => set({ ...extra, items })}
              />
            </>
          )}
        </Entries>
      </Section>

      <Section
        id="design"
        title="Design"
        hint="Applies to the PDF. The layout shrinks to fit the page limit."
      >
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
            label="Paper"
            value={style.paper}
            options={[
              { value: "letter", label: "US Letter" },
              { value: "a4", label: "A4" },
            ]}
            onChange={(paper) => onStyle({ paper })}
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
          {style.template === "modern" && (
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Accent</span>
              <div className="flex gap-2" role="radiogroup" aria-label="Accent color">
                {ACCENTS.map((color) => (
                  // biome-ignore lint/a11y/useSemanticElements: a swatch button inside a radiogroup
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
      </Section>
    </div>
  );
}

/**
 * Skills are typed as one comma-separated line. The text being typed is kept here (a trailing comma has to
 * survive the keystroke), and is replaced only when the list changes from outside, such as an undo.
 */
function SkillItems({ items, onChange }: { items: string[]; onChange: (items: string[]) => void }) {
  const [draft, setDraft] = useState(items.join(", "));
  useEffect(() => {
    setDraft((current) =>
      splitItems(current).join("\n") === items.join("\n") ? current : items.join(", "),
    );
  }, [items]);
  return (
    <TextField
      label="Skills in this group"
      value={draft}
      placeholder="TypeScript, Go, SQL"
      className="min-w-0 flex-1"
      onChange={(value) => {
        setDraft(value);
        onChange(splitItems(value));
      }}
    />
  );
}

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
