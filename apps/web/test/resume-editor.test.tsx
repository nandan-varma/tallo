// @vitest-environment jsdom
import { defaultResumeDoc, type Resume } from "@tallo/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@/components/resume/Editor";

afterEach(cleanup);

/** The editor wired to real state, as the workspace wires it. */
function Harness({ start, onChange }: { start?: Partial<Resume>; onChange?: (r: Resume) => void }) {
  const [doc, setDoc] = useState(() => {
    const d = defaultResumeDoc();
    return { ...d, resume: { ...d.resume, ...start } };
  });
  return (
    <Editor
      resume={doc.resume}
      style={doc.style}
      onResume={(change) =>
        setDoc((d) => {
          const resume = change(d.resume);
          onChange?.(resume);
          return { ...d, resume };
        })
      }
      onStyle={(patch) => setDoc((d) => ({ ...d, style: { ...d.style, ...patch } }))}
    />
  );
}

const role = {
  company: "Acme",
  title: "Engineer",
  location: "",
  start: "2020",
  end: "Present",
  bullets: ["Built it."],
};

describe("resume editor", () => {
  it("edits the contact fields", () => {
    let latest: Resume | undefined;
    render(<Harness onChange={(r) => (latest = r)} />);
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Ada" } });
    expect(latest?.name).toBe("Ada");
    expect((screen.getByLabelText("Full name") as HTMLInputElement).value).toBe("Ada");
  });

  it("keeps a comma while skills are being typed, and stores a clean list", () => {
    let latest: Resume | undefined;
    render(
      <Harness
        start={{ skills: [{ label: "Langs", items: ["Go"] }] }}
        onChange={(r) => (latest = r)}
      />,
    );
    const box = screen.getByLabelText("Skills in this group") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "Go," } });
    expect(box.value).toBe("Go,");
    fireEvent.change(box, { target: { value: "Go, Rust" } });
    expect(latest?.skills[0]?.items).toEqual(["Go", "Rust"]);
  });

  it("adds a bullet on Enter and removes an empty one on Backspace", () => {
    let latest: Resume | undefined;
    render(<Harness start={{ experience: [role] }} onChange={(r) => (latest = r)} />);
    const first = screen.getByLabelText("Bullets 1");
    fireEvent.keyDown(first, { key: "Enter" });
    expect(latest?.experience[0]?.bullets).toEqual(["Built it.", ""]);

    const second = screen.getByLabelText("Bullets 2");
    fireEvent.keyDown(second, { key: "Backspace" });
    expect(latest?.experience[0]?.bullets).toEqual(["Built it."]);
  });

  it("reorders entries and asks twice before removing one", () => {
    let latest: Resume | undefined;
    const other = { ...role, company: "Globex", title: "Lead" };
    render(<Harness start={{ experience: [role, other] }} onChange={(r) => (latest = r)} />);

    fireEvent.click(screen.getByRole("button", { name: "Move Engineer down" }));
    expect(latest?.experience.map((j) => j.company)).toEqual(["Globex", "Acme"]);

    fireEvent.click(screen.getByRole("button", { name: "Remove Lead" }));
    expect(latest?.experience).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Remove?" }));
    expect(latest?.experience.map((j) => j.company)).toEqual(["Acme"]);
  });

  it("offers an accent color only for the modern template", () => {
    render(<Harness />);
    expect(screen.queryByRole("radiogroup", { name: "Accent color" })).toBeNull();
    const template = screen.getByRole("radiogroup", { name: "Template" });
    fireEvent.click(within(template).getByRole("radio", { name: /Modern/ }));
    expect(screen.getByRole("radiogroup", { name: "Accent color" })).toBeTruthy();
  });
});
