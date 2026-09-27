// Seed stages, in dependency order. Each stage only uses the real API as the
// persona who would perform the action.
import { availability, futureBookings } from './bookings.mjs';
import { commercial, governance } from './commercial.mjs';
import { elapsed } from './elapsed.mjs';
import { engagement } from './engagement.mjs';
import { identities } from './identities.mjs';
import { sellers } from './sellers.mjs';
import { verification } from './verification.mjs';

export const STAGES = [identities, sellers, commercial, governance, availability, futureBookings, elapsed, engagement, verification];
