'use strict';

/**
 * identityService.js
 *
 * Implements the Master Patient Index (MPI) / patient-matching design in
 * docs/design.md Section 4 ("Patient Matching / Master Patient Index").
 *
 * This module answers a question the blockchain layer cannot: "have we
 * seen this person before, under a different hospital's MRN?" It never
 * writes to the ledger and never stores anything that goes on-chain --
 * only the resulting PatientChain DID is ever registered there (by the
 * caller, via ledgerService.registerPatient). The demographic attributes
 * used for matching (name, date of birth, sex, phone, NIN) stay in this
 * module's own store, exactly as Section 4 specifies.
 */
class IdentityService {
  constructor() {
    // patientDID -> demographics
    this.demographics = new Map();
  }

  static normalize(value) {
    return (value || '').toString().trim().toLowerCase();
  }

  /** Classic Levenshtein edit distance, used for fuzzy name matching. */
  static levenshtein(a, b) {
    const s = a || '';
    const t = b || '';
    const m = s.length;
    const n = t.length;
    if (m === 0) return n;
    if (n === 0) return m;

    const prev = new Array(n + 1);
    const curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;

    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = s[i - 1] === t[j - 1] ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      }
      for (let j = 0; j <= n; j++) prev[j] = curr[j];
    }
    return prev[n];
  }

  static nameSimilarity(a, b) {
    const na = IdentityService.normalize(a);
    const nb = IdentityService.normalize(b);
    if (!na || !nb) return 0;
    const distance = IdentityService.levenshtein(na, nb);
    return 1 - distance / Math.max(na.length, nb.length, 1);
  }

  /**
   * Weighted demographic similarity between a stored record and a query,
   * per docs/design.md Section 4's "deterministic match / probabilistic
   * match" split. Returns a score in [0, 1].
   */
  static demographicScore(candidate, query) {
    const weights = { name: 0.4, dob: 0.25, sex: 0.1, phone: 0.25 };
    let score = 0;

    score += weights.name * IdentityService.nameSimilarity(candidate.name, query.name);

    if (candidate.dob && query.dob) {
      score += weights.dob * (IdentityService.normalize(candidate.dob) === IdentityService.normalize(query.dob) ? 1 : 0);
    }
    if (candidate.sex && query.sex) {
      score += weights.sex * (IdentityService.normalize(candidate.sex) === IdentityService.normalize(query.sex) ? 1 : 0);
    }
    if (candidate.phone && query.phone) {
      score += weights.phone * (IdentityService.normalize(candidate.phone) === IdentityService.normalize(query.phone) ? 1 : 0);
    }
    return Math.round(score * 1000) / 1000;
  }

  /**
   * matchPatient runs the MPI algorithm from docs/design.md Section 4
   * against every demographic record registered so far, and classifies
   * the result the same way the design's flowchart does:
   *
   *   - CONFIDENT_MATCH      deterministic NIN hit, or a very high
   *                          probabilistic score -- safe to auto-link.
   *   - POSSIBLE_DUPLICATE   a moderate score -- must go to a manual
   *                          review queue, never auto-merged.
   *   - NEW                  no meaningful match -- safe to register as
   *                          a new PatientChain ID.
   */
  matchPatient(query) {
    const nin = IdentityService.normalize(query.nin);
    if (nin) {
      for (const [patientDID, candidate] of this.demographics.entries()) {
        if (candidate.nin && IdentityService.normalize(candidate.nin) === nin) {
          return {
            matchType: 'CONFIDENT_MATCH',
            method: 'deterministic-nin',
            patientDID,
            score: 1,
            candidates: [],
          };
        }
      }
    }

    const scored = Array.from(this.demographics.entries())
      .map(([patientDID, candidate]) => ({
        patientDID,
        score: IdentityService.demographicScore(candidate, query),
        candidate,
      }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best || best.score < 0.55) {
      return { matchType: 'NEW', method: 'probabilistic', patientDID: null, score: best ? best.score : 0, candidates: [] };
    }
    if (best.score >= 0.85) {
      return { matchType: 'CONFIDENT_MATCH', method: 'probabilistic', patientDID: best.patientDID, score: best.score, candidates: [] };
    }
    return {
      matchType: 'POSSIBLE_DUPLICATE',
      method: 'probabilistic',
      patientDID: null,
      score: best.score,
      candidates: scored.slice(0, 3).map((c) => ({ patientDID: c.patientDID, score: c.score, name: c.candidate.name })),
    };
  }

  /** Stores or updates the demographic attributes behind a PatientChain DID. */
  registerDemographics(patientDID, demographics) {
    if (!patientDID) throw new Error('patientDID is required to register demographics');
    const existing = this.demographics.get(patientDID) || {};
    const merged = {
      name: demographics.name ?? existing.name ?? null,
      dob: demographics.dob ?? existing.dob ?? null,
      sex: demographics.sex ?? existing.sex ?? null,
      phone: demographics.phone ?? existing.phone ?? null,
      nin: demographics.nin ?? existing.nin ?? null,
    };
    this.demographics.set(patientDID, merged);
    return merged;
  }

  getDemographics(patientDID) {
    return this.demographics.get(patientDID) || null;
  }

  static hasAnyDemographics(payload) {
    return Boolean(payload && (payload.name || payload.dob || payload.sex || payload.phone || payload.nin));
  }
}

// Singleton, mirroring fhirAdapter.js's pattern.
const identityService = new IdentityService();

module.exports = { IdentityService, identityService };
