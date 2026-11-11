// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SearchForm } from "@/components/SearchForm";

afterEach(cleanup);

describe("SearchForm", () => {
  it("is a plain GET form to /search with its fields labelled and filled", () => {
    const { container } = render(
      <SearchForm values={{ title: "data engineer", company: "", location: "Seattle" }} />,
    );

    const form = container.querySelector("form");
    expect(form?.getAttribute("action")).toBe("/search");
    expect(form?.getAttribute("method")).toBe("get");
    expect((screen.getByLabelText("Job title") as HTMLInputElement).value).toBe("data engineer");
    expect((screen.getByLabelText(/Company/) as HTMLInputElement).name).toBe("company");
    expect((screen.getByLabelText(/Location/) as HTMLInputElement).value).toBe("Seattle");
    expect(screen.getByRole("button", { name: "Search" }).getAttribute("type")).toBe("submit");
  });

  it("requires a title", () => {
    render(<SearchForm values={{ title: "", company: "", location: "" }} />);
    expect((screen.getByLabelText("Job title") as HTMLInputElement).required).toBe(true);
  });
});
