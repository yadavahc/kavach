/**
 * Corpus taxonomy. Dependency-free so browser code can use it without pulling
 * in the zod schemas (corpus/schema.ts re-exports everything here).
 */

export const SCAM_FAMILIES = [
  "digital_arrest", // fake police/CBI/ED keeping victim on video call under "arrest"
  "parcel_customs", // courier/customs parcel "seized" with contraband or unpaid duty
  "kyc_expiry", // bank/wallet/SIM KYC "expiring", account to be frozen
  "ceo_wire_fraud", // executive/vendor impersonation demanding urgent transfer
  "otp_harvest", // "fraud department" / refund / reward calls that extract OTP or PIN
  "tech_support", // fake Microsoft/ISP/bank-app support, remote-access install
  "romance_advance_fee", // online partner/investment friend needing fees released
  "family_emergency", // voice-cloned relative in trouble (accident, arrest, hospital)
] as const;
export type ScamFamily = (typeof SCAM_FAMILIES)[number];

export const FAMILIES = [...SCAM_FAMILIES, "benign"] as const;
export type Family = (typeof FAMILIES)[number];

/** Ordered coercion arc. Order is used by the stage tracker (stage can only advance or hold). */
export const STAGES = ["hook", "authority_claim", "isolation", "urgency", "extraction"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_ORDER: Record<Stage, number> = {
  hook: 1,
  authority_claim: 2,
  isolation: 3,
  urgency: 4,
  extraction: 5,
};

/** Pressure-meter dimensions. Each playbook entry carries an intensity 0-3 per signal. */
export const PRESSURE_SIGNALS = ["urgency", "isolation", "secrecy", "authority"] as const;
export type PressureSignal = (typeof PRESSURE_SIGNALS)[number];

/**
 * Who the caller claims to be. `known_contact` is the Voice Circle trigger:
 * a match on such an entry surfaces the out-of-band verification prompt.
 */
export const IMPERSONATION = ["authority", "institution", "company", "known_contact", "stranger", "none"] as const;
export type Impersonation = (typeof IMPERSONATION)[number];

export const LOCALES = ["en-IN", "en-US", "en-GB", "global"] as const;
export type Locale = (typeof LOCALES)[number];

export const GT_TOPICS = [
  "law_enforcement",
  "courts_legal",
  "customs_courier",
  "banking",
  "payments_upi",
  "telecom",
  "tax_government",
  "tech_support",
  "corporate_payments",
  "family_verification",
  "romance_investment",
] as const;
export type GroundTruthTopic = (typeof GT_TOPICS)[number];

export const VERDICTS = ["false", "true", "unverifiable"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const FAMILY_LABELS: Record<Family, string> = {
  digital_arrest: "Digital arrest",
  parcel_customs: "Parcel / customs",
  kyc_expiry: "KYC expiry",
  ceo_wire_fraud: "CEO / vendor wire fraud",
  otp_harvest: "OTP harvest",
  tech_support: "Tech support",
  romance_advance_fee: "Romance / advance fee",
  family_emergency: "Family emergency (voice clone)",
  benign: "No scam pattern",
};

export const STAGE_LABELS: Record<Stage, string> = {
  hook: "Hook",
  authority_claim: "Authority claim",
  isolation: "Isolation",
  urgency: "Urgency",
  extraction: "Extraction",
};
