import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

const STORAGE_KEY = "tallo:theme";
const THEME_COLOR = { light: "#fafafa", dark: "#09090b" } as const;

function applyTheme(dark: boolean) {
  document.documentElement.classList.toggle("dark", dark);
  localStorage.setItem(STORAGE_KEY, dark ? "dark" : "light");
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? THEME_COLOR.dark : THEME_COLOR.light);
}

/** Flips light and dark. The class on <html> is the source of truth; the inline script in Base.astro sets it before paint. */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    // Read the class the inline script already applied, and again after each view transition swap.
    const sync = () => setDark(document.documentElement.classList.contains("dark"));
    sync();
    document.addEventListener("astro:after-swap", sync);
    return () => document.removeEventListener("astro:after-swap", sync);
  }, []);

  const toggle = () => {
    applyTheme(!dark);
    setDark(!dark);
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={toggle}
    >
      {dark ? <Sun aria-hidden /> : <Moon aria-hidden />}
    </Button>
  );
}
