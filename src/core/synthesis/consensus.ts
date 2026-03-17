/**
 * Phase 8 — Consensus clustering for normalized provider findings
 *
 * Pure computation module: no LLM calls, no I/O.
 *
 * Given an array of NormalizedProviderResult (one per dispatched provider),
 * this module:
 *  - Flattens all findings into FindingWithSource records
 *  - Clusters semantically similar findings using Jaccard token overlap
 *  - Computes per-cluster agreement scores and outlier detection
 *  - Produces agreement/disagreement summaries and an ensemble confidence score
 *
 * The CLUSTER_SIMILARITY_THRESHOLD (0.35) is tuned to group findings that
 * share roughly a third or more of their title tokens — enough to detect
 * "voltage spike / voltage transient" as the same cluster without merging
 * unrelated findings.
 *
 * Phase 8 guardrail: keep clustering simple; the normalized result schema
 * must be stable before adding more sophisticated strategies.
 */

import type {
  ConsensusCluster,
  ConsensusResult,
  FindingWithSource,
  NormalizedFinding,
  NormalizedProviderResult,
  ProviderName,
} from "../../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum Jaccard similarity (on title tokens) to merge two findings into one cluster. */
const CLUSTER_SIMILARITY_THRESHOLD = 0.35;

/** Parse quality below this value → provider is excluded from consensus. */
const MIN_PARSE_QUALITY_FOR_CONSENSUS = 0.10;

/** Severity ordering for maxSeverity computation. */
const SEVERITY_RANK: Record<NonNullable<NormalizedFinding["severity"]>, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

/** Tokenize a finding title into a set of meaningful lowercase words. */
function tokenize(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

/** Jaccard similarity between two token sets. Returns 0 when both are empty. */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const w of a) {
    if (b.has(w)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Flatten findings from results
// ---------------------------------------------------------------------------

/**
 * Collect all findings from successful, high-quality results into a flat list
 * with source attribution.  Results below MIN_PARSE_QUALITY_FOR_CONSENSUS are
 * excluded — their provider name is returned separately.
 */
function flattenFindings(results: NormalizedProviderResult[]): {
  findings: FindingWithSource[];
  excludedProviders: ProviderName[];
} {
  const findings: FindingWithSource[] = [];
  const excludedProviders: ProviderName[] = [];

  for (const result of results) {
    if (result.status !== "succeeded") continue;
    if (result.parseQuality < MIN_PARSE_QUALITY_FOR_CONSENSUS) {
      excludedProviders.push(result.provider);
      continue;
    }
    for (const f of result.findings) {
      findings.push({
        ...f,
        // Preserve sourceProviders from the finding itself if set, then override
        sourceProvider: result.provider,
        sourceModel: result.model,
        sourceParseQuality: result.parseQuality,
      });
    }
  }

  return { findings, excludedProviders };
}

// ---------------------------------------------------------------------------
// Greedy clustering
// ---------------------------------------------------------------------------

interface MutableCluster {
  members: FindingWithSource[];
  titleTokens: Set<string>;
  providerNames: Set<ProviderName>;
}

/**
 * Greedy single-pass clustering:
 * Each finding is assigned to the first existing cluster whose representative
 * title tokens have Jaccard similarity >= CLUSTER_SIMILARITY_THRESHOLD with
 * the finding's title tokens.  If no such cluster exists, a new cluster is
 * started.
 *
 * The representative title tokens for a cluster are the union of all member
 * title tokens — this allows the cluster to grow incrementally while staying
 * semantically coherent.
 */
function greedyCluster(findings: FindingWithSource[]): MutableCluster[] {
  const clusters: MutableCluster[] = [];

  for (const finding of findings) {
    const tokens = tokenize(finding.title);
    let bestCluster: MutableCluster | undefined;
    let bestScore = CLUSTER_SIMILARITY_THRESHOLD - 0.001; // must exceed threshold

    for (const cluster of clusters) {
      const score = jaccardSimilarity(tokens, cluster.titleTokens);
      if (score > bestScore) {
        bestScore = score;
        bestCluster = cluster;
      }
    }

    if (bestCluster) {
      bestCluster.members.push(finding);
      bestCluster.providerNames.add(finding.sourceProvider);
      // Update representative tokens to be the union (broader coverage)
      for (const t of tokens) bestCluster.titleTokens.add(t);
    } else {
      clusters.push({
        members: [finding],
        titleTokens: new Set(tokens),
        providerNames: new Set([finding.sourceProvider]),
      });
    }
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Cluster finalization
// ---------------------------------------------------------------------------

/** Pick the representative title: use the member with the highest parse quality. */
function pickRepresentativeTitle(members: FindingWithSource[]): string {
  const best = [...members].sort((a, b) => b.sourceParseQuality - a.sourceParseQuality)[0];
  return best?.title ?? "Unknown finding";
}

/** Determine the highest severity seen in the cluster. */
function maxSeverity(
  members: FindingWithSource[],
): NormalizedFinding["severity"] | undefined {
  let best: NormalizedFinding["severity"] | undefined;
  let bestRank = -1;
  for (const m of members) {
    if (!m.severity) continue;
    const rank = SEVERITY_RANK[m.severity];
    if (rank > bestRank) {
      bestRank = rank;
      best = m.severity;
    }
  }
  return best;
}

/** Determine a shared category when all members agree on exactly one category. */
function sharedCategory(members: FindingWithSource[]): string | undefined {
  const cats = new Set(members.map((m) => m.category).filter(Boolean));
  return cats.size === 1 ? [...cats][0] : undefined;
}

/**
 * Convert a MutableCluster into a final ConsensusCluster.
 * agreementScore = providerCount / totalSuccessfulProviders.
 */
function finalizeCluster(
  cluster: MutableCluster,
  totalSuccessfulProviders: number,
): ConsensusCluster {
  const providerCount = cluster.providerNames.size;
  const agreementScore =
    totalSuccessfulProviders > 0 ? providerCount / totalSuccessfulProviders : 0;

  // Enrich sourceProviders on each member with the full cluster set
  const clusterProviders = [...cluster.providerNames];
  const enrichedMembers: FindingWithSource[] = cluster.members.map((m) => ({
    ...m,
    sourceProviders: clusterProviders,
  }));

  return {
    title: pickRepresentativeTitle(cluster.members),
    category: sharedCategory(cluster.members),
    maxSeverity: maxSeverity(cluster.members),
    members: enrichedMembers,
    providerCount,
    agreementScore: Math.round(agreementScore * 1000) / 1000,
    isOutlier: providerCount <= 1,
  };
}

// ---------------------------------------------------------------------------
// Cluster sorting
// ---------------------------------------------------------------------------

const SEVERITY_SORT_RANK: Record<NonNullable<NormalizedFinding["severity"]>, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

function sortClusters(clusters: ConsensusCluster[]): ConsensusCluster[] {
  return [...clusters].sort((a, b) => {
    // Primary: agreement score descending
    if (b.agreementScore !== a.agreementScore) return b.agreementScore - a.agreementScore;
    // Secondary: maxSeverity descending
    const aRank = a.maxSeverity ? SEVERITY_SORT_RANK[a.maxSeverity] : -1;
    const bRank = b.maxSeverity ? SEVERITY_SORT_RANK[b.maxSeverity] : -1;
    return bRank - aRank;
  });
}

// ---------------------------------------------------------------------------
// Summary builders
// ---------------------------------------------------------------------------

function buildAgreementSummary(
  clusters: ConsensusCluster[],
  totalProviders: number,
  excludedCount: number,
): string {
  if (clusters.length === 0) return "No parseable findings from any provider.";

  const multiProvider = clusters.filter((c) => !c.isOutlier);
  const unanimous = clusters.filter((c) => c.providerCount === totalProviders - excludedCount);
  const parts: string[] = [];

  parts.push(
    `${totalProviders} provider${totalProviders !== 1 ? "s" : ""} dispatched` +
      (excludedCount > 0 ? ` (${excludedCount} excluded due to low parse quality)` : "") +
      `, producing ${clusters.length} finding cluster${clusters.length !== 1 ? "s" : ""}.`,
  );

  if (unanimous.length > 0) {
    parts.push(
      `All active providers agreed on ${unanimous.length} finding${unanimous.length !== 1 ? "s" : ""}: ` +
        unanimous.slice(0, 3).map((c) => `"${c.title}"`).join(", ") +
        (unanimous.length > 3 ? ` and ${unanimous.length - 3} more` : "") +
        ".",
    );
  } else if (multiProvider.length > 0) {
    parts.push(
      `${multiProvider.length} finding${multiProvider.length !== 1 ? "s" : ""} ` +
        `were confirmed by multiple providers.`,
    );
  } else {
    parts.push("No findings were confirmed by more than one provider.");
  }

  return parts.join(" ");
}

function buildDisagreementSummary(clusters: ConsensusCluster[]): string {
  const outliers = clusters.filter((c) => c.isOutlier);
  if (outliers.length === 0) return "No outlier findings — all clusters have multi-provider agreement.";

  const topOutliers = outliers
    .slice(0, 5)
    .map(
      (c) =>
        `"${c.title}" (${c.members[0]?.sourceProvider ?? "unknown"})`,
    )
    .join("; ");

  return (
    `${outliers.length} outlier finding${outliers.length !== 1 ? "s" : ""} raised by only one provider: ` +
    topOutliers +
    (outliers.length > 5 ? ` and ${outliers.length - 5} more` : "") +
    "."
  );
}

// ---------------------------------------------------------------------------
// Confidence score
// ---------------------------------------------------------------------------

/**
 * Ensemble confidence heuristic (0–1):
 *  - 60% weight on average cluster agreement score (how well providers agreed)
 *  - 40% weight on average parse quality across contributing results
 */
function computeEnsembleConfidence(
  clusters: ConsensusCluster[],
  results: NormalizedProviderResult[],
): number {
  const successResults = results.filter((r) => r.status === "succeeded");
  if (!successResults.length) return 0;

  const avgParseQuality =
    successResults.reduce((sum, r) => sum + r.parseQuality, 0) / successResults.length;

  const avgAgreement =
    clusters.length > 0
      ? clusters.reduce((sum, c) => sum + c.agreementScore, 0) / clusters.length
      : 0;

  const score = Math.round((0.6 * avgAgreement + 0.4 * avgParseQuality) * 100) / 100;
  return Math.min(1, Math.max(0, score));
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Compute consensus clustering across all normalized provider results.
 *
 * Invariant: this function never throws.  If results is empty or no findings
 * are available, it returns a valid ConsensusResult with empty clusters.
 */
export function computeConsensus(results: NormalizedProviderResult[]): ConsensusResult {
  const successfulResults = results.filter((r) => r.status === "succeeded");
  const totalSuccessful = successfulResults.length;

  if (totalSuccessful === 0) {
    return {
      clusters: [],
      excludedProviders: [],
      agreementSummary: "No successful provider results available for consensus.",
      disagreementSummary: "",
      ensembleConfidence: 0,
    };
  }

  const { findings, excludedProviders } = flattenFindings(successfulResults);
  const activeProviderCount = totalSuccessful - excludedProviders.length;

  if (findings.length === 0) {
    return {
      clusters: [],
      excludedProviders,
      agreementSummary:
        activeProviderCount > 0
          ? `${activeProviderCount} provider${activeProviderCount !== 1 ? "s" : ""} succeeded but produced no structured findings.`
          : "All providers were excluded due to low parse quality.",
      disagreementSummary: "",
      ensembleConfidence: computeEnsembleConfidence([], successfulResults),
    };
  }

  const rawClusters = greedyCluster(findings);
  const finalClusters = sortClusters(
    rawClusters.map((c) => finalizeCluster(c, activeProviderCount)),
  );

  return {
    clusters: finalClusters,
    excludedProviders,
    agreementSummary: buildAgreementSummary(
      finalClusters,
      totalSuccessful,
      excludedProviders.length,
    ),
    disagreementSummary: buildDisagreementSummary(finalClusters),
    ensembleConfidence: computeEnsembleConfidence(finalClusters, successfulResults),
  };
}
