// Guardrails: actions with real-world consequences need the user's approval before they run.
// Checked in code for every input, whether the model chose it or it was replayed from memory.

// Clicks that commit money, bookings, messages, accounts or deletions.
const SERIOUS = new RegExp(
  "\\b(" + [
    "buy", "purchase", "pay", "payment", "checkout", "check out", "place (your )?order", "order now",
    "complete (your )?(order|purchase|booking|payment)", "book", "book now", "reserve", "confirm",
    "subscribe", "sign up", "register", "create (an )?account", "send", "post", "publish", "submit",
    "delete", "cancel (my |your )?(order|booking|subscription|account)", "unsubscribe", "close account",
    "transfer", "donate", "withdraw", "apply now", "add payment", "save card", "upgrade", "start (free )?trial",
  ].join("|") + ")\\b",
  "i",
);

// Fields whose contents are payment details, credentials or identity numbers.
const SENSITIVE_FIELD = /card|cvv|cvc|security code|expir|iban|swift|account number|routing|password|passcode|pin\b|ssn|social security|cpr|passport/i;

// Pages where any button or typed value can be part of paying.
const PAYMENT_PAGE = /checkout|payment|billing|\/pay\b|\/order\b|\/basket\/confirm/i;

export function seriousReason(action, page) {
  if (action.kind === "scroll" || action.kind === "wait") return null;
  const label = action.label ?? "";
  if (action.kind === "fill" && SENSITIVE_FIELD.test(label)) return `types into a sensitive field (“${label}”)`;
  if (action.kind !== "fill" && SERIOUS.test(label)) return `may commit something (“${label}”)`;
  let path = "";
  try {
    path = new URL(page.url).pathname;
  } catch {}
  if (PAYMENT_PAGE.test(path) && (action.kind === "fill" || ["button", "link"].includes(action.role ?? ""))) {
    return "acts on a checkout or payment page";
  }
  return null;
}
