import type { Unit } from "@/lib/academy/types";
import { mission1 } from "./mission-1";
import { unit1 } from "./unit-1";
import { unit2 } from "./unit-2";
import { unit3 } from "./unit-3";
import { unit4 } from "./unit-4";
import { unit5 } from "./unit-5";
import { unit6 } from "./unit-6";
import { unit7 } from "./unit-7";

/** Market City's story mission opens Unit 1 (the map's Level 01); the unit's lessons follow it. */
export const UNITS: Unit[] = [{ ...unit1, lessons: [mission1, ...unit1.lessons] }, unit2, unit3, unit4, unit5, unit6, unit7];
