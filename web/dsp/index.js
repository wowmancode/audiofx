// Importing each module registers its effects.
import './dynamics.js';
import './filters.js';
import './modulation.js';
import './time.js';
import './pitch.js';
import './spatial.js';
import './vocoder.js';
import './custom.js';

export { createEffect, effectMeta, REGISTRY } from './core.js';
