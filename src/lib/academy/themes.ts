/** The Academy map worlds: four looks for the same roadmap (lessons, unlocks and rewards are shared). */
export const ACADEMY_THEMES = ["metropolis", "cosmos", "circuit", "expedition"] as const;
export type AcademyTheme = (typeof ACADEMY_THEMES)[number];

/** The world a learner sees before choosing one. */
export const DEFAULT_THEME: AcademyTheme = "expedition";
