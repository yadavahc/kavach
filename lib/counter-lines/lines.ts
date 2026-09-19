/**
 * Pre-written counter-lines: short, calm sentences the person on the call can
 * say out loud. They end the conversation or move verification to a channel
 * the caller does not control. Written per family and stage so the right line
 * renders the instant a pattern is matched, with no network call.
 */
import type { ScamFamily, Stage } from "../../corpus/taxonomy";

export interface CounterLine {
  say: string;
  /** What to do right after saying it. */
  then: string;
}

type StageLines = Record<Stage, CounterLine>;

export const COUNTER_LINES: Record<ScamFamily, StageLines> = {
  digital_arrest: {
    hook: { say: "I don't discuss cases over the phone. Please send a written notice to my address.", then: "Hang up. Real police send written notices." },
    authority_claim: { say: "I'll verify this with my local police station myself and call back from there.", then: "Hang up and dial 112 or visit the station in person." },
    isolation: { say: "I'm ending this call now and speaking to my family and a lawyer.", then: "Hang up. No law stops you telling your family." },
    urgency: { say: "If a warrant exists, officers can serve it in person. I'm hanging up now.", then: "Hang up. Report the number at cybercrime.gov.in or 1930." },
    extraction: { say: "I will not transfer any money on a phone call. This conversation is over.", then: "Hang up. No agency verifies money by moving it." },
  },
  parcel_customs: {
    hook: { say: "I'll check the tracking myself on the courier's official website.", then: "Hang up and type the courier's site yourself." },
    authority_claim: { say: "Customs can send me a written notice. I won't give a statement on this call.", then: "Hang up. Don't open links sent by the caller." },
    isolation: { say: "I'm going to talk this over with my family before anything else.", then: "Hang up and tell someone you trust." },
    urgency: { say: "If there's a real problem with a parcel, it can wait for a written notice.", then: "Hang up. Deadlines on calls are a pressure tactic." },
    extraction: { say: "I don't pay duties to UPI IDs or share card details on calls. Goodbye.", then: "Hang up. Never enter a PIN to clear a parcel." },
  },
  kyc_expiry: {
    hook: { say: "I'll update my KYC at my branch or in the bank's own app.", then: "Hang up and use the number on your card." },
    authority_claim: { say: "I'll call my bank back on the number printed on my card.", then: "Hang up. Caller ID and employee codes are easy to fake." },
    isolation: { say: "I prefer to visit my branch. I'm ending this call.", then: "Hang up. The branch will confirm it's fake." },
    urgency: { say: "My bank gives written notice for KYC. I'm not doing this on a call.", then: "Hang up. Don't install any app they send." },
    extraction: { say: "I never share codes, PINs or install apps for anyone on a call. Goodbye.", then: "Hang up. That code would unlock your account." },
  },
  ceo_wire_fraud: {
    hook: { say: "Happy to help. I'll call you back on your usual number first.", then: "Call back on the number already in your contacts." },
    authority_claim: { say: "This needs to go through our normal approval process like every payment.", then: "Loop in your approver before anything moves." },
    isolation: { say: "I have to include finance on any payment. That's our policy.", then: "Tell your manager. Secrecy requests are the red flag." },
    urgency: { say: "I'll confirm with you on your known number, then process it if it's real.", then: "Call back. A real deadline survives a two-minute check." },
    extraction: { say: "I can't send funds or gift cards from a phone request. Let's verify first.", then: "Stop the payment and call the person on a trusted number." },
  },
  otp_harvest: {
    hook: { say: "I'll check my account in my bank's app and call the number on my card.", then: "Hang up and call the card's number." },
    authority_claim: { say: "My bank tells me never to share codes. I'll call them back directly.", then: "Hang up. Knowing your card digits proves nothing." },
    isolation: { say: "I'm going to call the number on the back of my card right now.", then: "Hang up. That number is the safe channel." },
    urgency: { say: "If a payment is fraudulent, my bank can reverse it. I'll call them myself.", then: "Hang up and call your bank." },
    extraction: { say: "I will not read out any code or PIN to anyone. Goodbye.", then: "Hang up. The code authorises their payment, not yours." },
  },
  tech_support: {
    hook: { say: "I didn't ask for support, so I'm going to hang up.", then: "Hang up. Companies don't cold-call about viruses." },
    authority_claim: { say: "I'll contact support myself through the official website if I need it.", then: "Hang up. Don't open event viewer on their instructions." },
    isolation: { say: "I'm going to ask my family to look at this with me first.", then: "Hang up and switch off the internet if they had access." },
    urgency: { say: "Restarting my computer is safe. I'm ending this call.", then: "Hang up and restart. The warning page is fake." },
    extraction: { say: "I won't install anything or share any access code. Goodbye.", then: "Hang up. If you installed something, disconnect and get help." },
  },
  romance_advance_fee: {
    hook: { say: "Let's talk on a video call first before anything else.", then: "Insist on a live video call before trusting anyone." },
    authority_claim: { say: "I'd like to meet on video before we talk about anything more.", then: "Stay on the dating platform and verify." },
    isolation: { say: "My family is part of my life. I'll be telling them about you.", then: "Tell someone. Secrecy protects the scammer." },
    urgency: { say: "I can't send money for this. Please ask someone near you for help.", then: "Don't send money to someone you've never met." },
    extraction: { say: "I don't send money or gift cards to people I haven't met in person.", then: "Stop contact and report the profile." },
  },
  family_emergency: {
    hook: { say: "I love you. Tell me our family code word first.", then: "Ask for the household passphrase." },
    authority_claim: { say: "I'll call the police station and hospital back on their listed numbers.", then: "Hang up and call the official number yourself." },
    isolation: { say: "I'm going to call your parents and your own number right now.", then: "Hang up and call the relative directly." },
    urgency: { say: "I'll call you back on your usual number in two minutes.", then: "Call their real number. A real emergency survives a call-back." },
    extraction: { say: "I won't send cash or transfers until I've spoken to you on your own phone.", then: "Hang up and verify through someone else in the family." },
  },
};

export const GENERIC_LINE: CounterLine = {
  say: "I'll call you back on a number I already have.",
  then: "Hang up and verify through a channel the caller doesn't control.",
};

export function counterLineFor(family: ScamFamily | "benign" | null, stage: Stage | "none"): CounterLine {
  if (!family || family === "benign") return GENERIC_LINE;
  return stage === "none" ? COUNTER_LINES[family].hook : COUNTER_LINES[family][stage];
}
