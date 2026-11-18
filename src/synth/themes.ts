// Bridge 4 of joining PMX and PMX Engine (EQ-38): roadmap theme names as Linear labels. PMX Engine's /pmxe-memory puts
// `memory/engine/themes.json` in the team's repo, through a reviewed pull request: only themes on the product managers'
// page that every group may see. PMX reads that file and nothing else of Engine's. Synthesis may suggest one theme per
// task; the PM keeps, changes or clears it before approving; the label goes on in the `pmx-theme` group.
import { join } from "node:path";
import { readJson } from "../core/fsutil.js";

export const THEMES_FILE = join("memory", "engine", "themes.json");
/** The format of themes.json this pmx reads. A file at another number is ignored, and `pmx doctor` says so. */
export const THEMES_FORMAT = 1;
export const THEME_NAME_MAX = 60;
const MAX_THEMES = 50;

export interface RoadmapTheme {
  id: string;
  name: string;
}

/** What the team's repo offers: its open themes, or why it offers none. */
export interface ThemeList {
  themes: RoadmapTheme[];
  /** null when the repo has no themes.json; otherwise the format it was written at. */
  format: number | null;
}

const validName = (n: unknown): n is string => typeof n === "string" && n.trim() === n && n.length > 0 && n.length <= THEME_NAME_MAX && !/[\u0000-\u001f]/.test(n);

/** The open roadmap themes in the team's repo. Anything that isn't a short plain name is left out, never shortened. */
export async function readThemes(repo: string): Promise<ThemeList> {
  let raw: any;
  try {
    raw = await readJson<any>(join(repo, THEMES_FILE));
  } catch {
    return { themes: [], format: 0 };
  }
  if (raw === null) return { themes: [], format: null };
  const format = typeof raw?.format === "number" ? raw.format : 0;
  if (format !== THEMES_FORMAT || !Array.isArray(raw.themes)) return { themes: [], format };
  const themes: RoadmapTheme[] = [];
  for (const t of raw.themes) {
    if (!t || typeof t.id !== "string" || !/^b-[a-z0-9]{4,8}$/.test(t.id) || !validName(t.name)) continue;
    if (themes.some((x) => x.name.toLowerCase() === t.name.toLowerCase())) continue;
    themes.push({ id: t.id, name: t.name });
    if (themes.length === MAX_THEMES) break;
  }
  return { themes, format };
}

export async function openThemes(repo: string): Promise<RoadmapTheme[]> {
  return (await readThemes(repo)).themes;
}

/** The theme a name stands for, matched without regard to case, so the label is always the theme's own spelling. */
export function themeNamed(name: unknown, themes: RoadmapTheme[]): string | null {
  if (typeof name !== "string") return null;
  const n = name.trim().toLowerCase();
  return themes.find((t) => t.name.toLowerCase() === n)?.name ?? null;
}

/** The prompt block that offers the themes to synthesis. Empty when there are none, so nothing changes for most teams. */
export function themeBlock(themes: RoadmapTheme[]): string {
  if (!themes.length) return "";
  return [
    "",
    "## Roadmap themes",
    "Your team's roadmap has these open themes. When a task clearly serves one, give `theme`: its name exactly as listed. Otherwise leave `theme` out. Never invent a theme or pick the nearest one to have one; the PM checks every theme before it reaches the tracker.",
    ...themes.map((t) => `- ${t.name}`),
  ].join("\n");
}
