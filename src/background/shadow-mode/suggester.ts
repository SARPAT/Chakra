// Shadow Mode Suggester — Ring Map + policy suggestions
//
// Converts Analyser outputs into human-reviewable suggestions.
// Feeds into the Dashboard's Learning screen.
//
// Three deliverables:
//   1. Ring Map suggestion — block groupings + level assignments
//   2. RPM threshold suggestion — when to activate each level
//   3. Policy rule suggestions — journey-aware + tier-aware rules
//
// CHAKRA never auto-activates policies. These are suggestions only.
// A human developer approves before anything takes effect.

import type { ShadowModeAnalyser, BlockSuggestion, MomentOfValueSignature } from './analyser';
import type { PolicyRule } from '../../core/policy-engine';

// ─── Suggestion types ─────────────────────────────────────────────────────────

export interface RingMapSuggestion {
  /** Whether there is enough data to make this suggestion */
  ready: boolean;
  blocks: BlockSuggestion[];
  /** Human-readable summary */
  summary: string;
  /** ISO timestamp when this suggestion was generated */
  generatedAt: string;
}

export interface RPMThresholdSuggestion {
  ready: boolean;
  activateLevel1At: number;
  activateLevel2At: number;
  activateLevel3At: number;
  deactivateBelow: number;
  baselineRpm: number;
  peakRpm: number;
  summary: string;
  generatedAt: string;
}

export interface PolicySuggestion {
  id: string;
  rule: PolicyRule;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  layer: 1 | 2 | 3 | 4;
}

export interface AllSuggestions {
  ringMap: RingMapSuggestion;
  rpmThresholds: RPMThresholdSuggestion;
  policies: PolicySuggestion[];
}

// ─── ShadowModeSuggester ──────────────────────────────────────────────────────

export class ShadowModeSuggester {
  private readonly analyser: ShadowModeAnalyser;

  constructor(analyser: ShadowModeAnalyser) {
    this.analyser = analyser;
  }

  // ─── Main output ──────────────────────────────────────────────────────────────

  /**
   * Generate all current suggestions from the latest analysis state.
   * Safe to call at any time — returns partial suggestions if layers incomplete.
   */
  getSuggestions(): AllSuggestions {
    return {
      ringMap: this.getRingMapSuggestion(),
      rpmThresholds: this.getRPMThresholdSuggestion(),
      policies: this.getPolicySuggestions(),
    };
  }

  // ─── Ring Map suggestion ──────────────────────────────────────────────────────

  getRingMapSuggestion(): RingMapSuggestion {
    const progress = this.analyser.getLearningProgress();
    const blocks = this.analyser.getBlockSuggestions();
    const ready = progress.layer1AppStructure === 'complete' && blocks.length > 0;

    if (!ready) {
      return {
        ready: false,
        blocks: [],
        summary: `Learning in progress — ${progress.totalObservations} observations so far. Need ${500} to generate Ring Map.`,
        generatedAt: new Date().toISOString(),
      };
    }

    return {
      ready: true,
      blocks,
      summary: `${blocks.length} blocks identified from ${progress.totalObservations} observations across ${this.analyser.getEndpointStats().length} endpoints.`,
      generatedAt: new Date().toISOString(),
    };
  }

  // ─── RPM threshold suggestion ─────────────────────────────────────────────────

  getRPMThresholdSuggestion(): RPMThresholdSuggestion {
    const progress = this.analyser.getLearningProgress();
    const pattern = this.analyser.getTrafficPattern();
    const ready = progress.layer2TrafficPatterns === 'complete' && pattern !== null;

    if (!ready || pattern === null) {
      return {
        ready: false,
        activateLevel1At: 60,
        activateLevel2At: 75,
        activateLevel3At: 90,
        deactivateBelow: 45,
        baselineRpm: 0,
        peakRpm: 0,
        summary: `Traffic pattern learning in progress — need ${7} days of data.`,
        generatedAt: new Date().toISOString(),
      };
    }

    const base = pattern.baselineRpm;
    const level1 = Math.round(base * 1.5);
    const level2 = Math.round(base * 2.0);
    const level3 = Math.round(base * 2.5);
    const deactivate = Math.round(base * 1.2);

    return {
      ready: true,
      activateLevel1At: level1,
      activateLevel2At: level2,
      activateLevel3At: level3,
      deactivateBelow: deactivate,
      baselineRpm: base,
      peakRpm: pattern.peakRpm,
      summary: `Based on ${progress.daysObserved} days of traffic. Baseline RPM: ${base}. Suggested activation at ${level1} (Level 1), ${level2} (Level 2), ${level3} (Level 3).`,
      generatedAt: new Date().toISOString(),
    };
  }

  // ─── Policy suggestions ───────────────────────────────────────────────────────

  getPolicySuggestions(): PolicySuggestion[] {
    const suggestions: PolicySuggestion[] = [];
    const progress = this.analyser.getLearningProgress();
    const pattern = this.analyser.getTrafficPattern();
    const movSigs = this.analyser.getMomentOfValueSignatures();

    // Layer 1 suggestions: protect high-call-frequency write endpoints
    if (progress.layer1AppStructure === 'complete') {
      const stats = this.analyser.getEndpointStats();
      const writeHeavy = stats.filter(s => s.isWriteHeavy && s.callCount > 100);

      for (const stat of writeHeavy.slice(0, 3)) {
        suggestions.push({
          id: `layer1-write-${suggestions.length}`,
          rule: {
            name: `protect-write-${stat.endpoint.replace(/[^a-z0-9]/gi, '-')}`,
            if: { path_matches: `${stat.endpoint}**` },
            then: { action: 'serve_fully' },
            priority: 100,
          },
          reason: `High-frequency write endpoint (${stat.callCount} calls observed). Suspending it risks data loss.`,
          confidence: 'high',
          layer: 1,
        });
      }
    }

    // Layer 2 suggestions: cache-based rules for high-traffic periods
    if (progress.layer2TrafficPatterns === 'complete' && pattern !== null) {
      const base = pattern.baselineRpm;
      suggestions.push({
        id: 'layer2-cache-search',
        rule: {
          name: 'cache-search-above-threshold',
          if: { rpm_above: Math.round(base * 1.8) },
          then: { action: 'serve_limited', hint: 'use-cached-results' },
          priority: 50,
        },
        reason: `Search/browse endpoints can serve cached results above RPM ${Math.round(base * 1.8)} without user impact.`,
        confidence: 'medium',
        layer: 2,
      });
    }

    // Layer 3 suggestions: Moment of Value protection
    if (progress.layer3UserBehaviour === 'complete' && movSigs.length > 0) {
      suggestions.push(...this.buildMoVPolicySuggestions(movSigs));
    }

    return suggestions;
  }

  // ─── MoV policy builder ───────────────────────────────────────────────────────

  private buildMoVPolicySuggestions(signatures: MomentOfValueSignature[]): PolicySuggestion[] {
    const suggestions: PolicySuggestion[] = [];

    for (const sig of signatures.slice(0, 3)) {
      // Protect the final conversion endpoint unconditionally
      const lastEndpoint = sig.endpointSequence[sig.endpointSequence.length - 1];
      if (!lastEndpoint) continue;

      suggestions.push({
        id: `layer3-mov-${sig.id}`,
        rule: {
          name: `protect-conversion-${sig.id}`,
          if: {
            path_matches: `${lastEndpoint}**`,
            moment_of_value_any: true,
          },
          then: { action: 'serve_fully' },
          priority: 200,
        },
        reason: `${sig.name}: sessions matching this sequence (observed ${sig.observedCount} times) are at high conversion probability. Protect the final step.`,
        confidence: sig.confidence > 0.7 ? 'high' : 'medium',
        layer: 3,
      });
    }

    return suggestions;
  }
}
