// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeToggle } from "@/components/ThemeToggle";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  cleanup();
});

describe("ThemeToggle", () => {
  it("flips the dark class, storage and label, and flips back", () => {
    render(<ThemeToggle />);
    const button = screen.getByRole("button", { name: "Switch to dark theme" });

    fireEvent.click(button);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("tallo:theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Switch to light theme" }));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("tallo:theme")).toBe("light");
    expect(screen.getByRole("button", { name: "Switch to dark theme" })).toBeTruthy();
  });

  it("starts from the class the inline script applied", () => {
    document.documentElement.classList.add("dark");
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeTruthy();
  });
});
