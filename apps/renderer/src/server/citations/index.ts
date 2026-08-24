export type {
  CitationRejectionReason,
  CitationResolutionResult,
  EvidenceBundle,
  RejectedCitation,
  ResolvedCitation,
} from "./resolver";
export { computeQuoteHash, normalizeQuoteText, resolveCitations } from "./resolver";
export type { CitationMarkerOccurrence, MarkerScanResult } from "./marker-scanner";
export { CitationMarkerScanner } from "./marker-scanner";
