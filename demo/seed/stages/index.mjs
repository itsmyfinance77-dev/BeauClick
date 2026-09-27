// Seed stages, in dependency order. Each stage only uses the real API as the
// persona who would perform the action.
import { commercial, governance } from './commercial.mjs';
import { identities } from './identities.mjs';
import { sellers } from './sellers.mjs';

export const STAGES = [identities, sellers, commercial, governance];
