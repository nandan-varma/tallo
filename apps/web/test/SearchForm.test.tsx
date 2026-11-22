// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SearchForm } from "@/components/SearchForm";

afterEach(cleanup);

describe("SearchForm", () => {
  it("is a plain GET form to /search with its fields labelled and filled", () => {
    const { container } = render(
      <SearchForm
        values={{
          title: "data engineer",
          company: "",
          location: "Seattle",
          country: "",
          sort: "",
          postedWithin: "",
        }}
      />,
    );

    const form = container.querySelector("form");
    expect(form?.getAttribute("action")).toBe("/search");
    expect(form?.getAttribute("method")).toBe("get");
    expect((screen.getByLabelText("Job title") as HTMLInputElement).value).toBe("data engineer");
    expect((screen.getByLabelText(/Company/) as HTMLInputElement).name).toBe("company");
    expect((screen.getByLabelText(/Location/) as HTMLInputElement).value).toBe("Seattle");
    expect(screen.getByRole("button", { name: "Search" }).getAttribute("type")).toBe("submit");
  });

  it("lets a company stand in for a title, and offers country, date and sort controls", () => {
    render(
      <SearchForm
        values={{
          title: "",
          company: "Stripe",
          location: "",
          country: "US",
          sort: "recent",
          postedWithin: "7",
        }}
      />,
    );
    expect((screen.getByLabelText("Job title") as HTMLInputElement).required).toBe(false);
    expect(screen.getByText(/A title or a company is required/)).toBeTruthy();
    expect((screen.getByLabelText(/Country/) as HTMLInputElement).name).toBe("country");
    expect((screen.getByLabelText(/Posted/) as unknown as HTMLSelectElement).value).toBe("7");
    expect((screen.getByLabelText("Sort") as unknown as HTMLSelectElement).value).toBe("recent");
  });
});
