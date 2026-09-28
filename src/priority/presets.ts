// Emergency presets: named band overrides for incident response.
//
//   c.setOverrides(EMERGENCY_PRESETS['shed-normal']);
//
// `critical` is never closed by a preset, so an operator cannot take checkout
// down by picking the wrong one. 'restore-all' reopens every band.

import type { Overrides } from '../core/admission';

export type EmergencyPreset = 'restore-all' | 'shed-sheddable' | 'shed-normal' | 'critical-only';

export const EMERGENCY_PRESETS: Readonly<Record<EmergencyPreset, Overrides>> = Object.freeze({
  'restore-all': Object.freeze({ closedBands: Object.freeze([]) }),
  'shed-sheddable': Object.freeze({ closedBands: Object.freeze(['sheddable'] as const) }),
  'shed-normal': Object.freeze({ closedBands: Object.freeze(['normal', 'sheddable'] as const) }),
  'critical-only': Object.freeze({
    closedBands: Object.freeze(['high', 'normal', 'sheddable'] as const),
  }),
});
