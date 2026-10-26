// @vitest-environment jsdom
import { emptyResume, type Resume } from "@tallo/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ResumeChecks } from "@/components/resume/ResumeChecks";

afterEach(cleanup);

const incomplete: Resume = {
  ...emptyResume(),
  name: "Ada Lovelace",
  experience: [
    {
      company: "Acme",
      title: "Engineer",
      location: "",
      start: "",
      end: "",
      bullets: [],
    },
  ],
};

const complete: Resume = {
  ...emptyResume(),
  name: "Ada Lovelace",
  email: "ada@example.com",
  phone: "+44 20 7946 0000",
  summary: "Engineer who builds payment systems.",
  experience: [
    {
      company: "Acme",
      title: "Engineer",
      location: "",
      start: "Jan 2020",
      end: "Present",
      bullets: ["Shipped the billing rewrite", "Cut build time by half"],
    },
  ],
  skills: [{ label: "Languages", items: ["TypeScript"] }],
};

describe("ResumeChecks", () => {
  it("renders nothing for an empty resume", () => {
    const { container } = render(<ResumeChecks resume={emptyResume()} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the fix count and messages for an incomplete resume", () => {
    render(<ResumeChecks resume={incomplete} />);
    expect(screen.getByText("4 to fix")).toBeTruthy();
    expect(screen.getByText("Add your email address.")).toBeTruthy();
    expect(screen.getByText("Add dates to your role at Acme.")).toBeTruthy();
  });

  it("collapses and expands the list from the header", () => {
    render(<ResumeChecks resume={incomplete} />);
    const header = screen.getByRole("button", { name: /Checks/ });
    expect(header.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Add your email address.")).toBeNull();

    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Add your email address.")).toBeTruthy();
  });

  it("says the resume looks complete when there is nothing to check", () => {
    render(<ResumeChecks resume={complete} />);
    expect(screen.getByText("Looks complete")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
