// Seed stages, in dependency order. Each stage only uses the real API as the
// persona who would perform the action.
import { identities } from './identities.mjs';

export const STAGES = [identities];
