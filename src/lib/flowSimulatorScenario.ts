export type SimulatorScenario = {
  ai: "answer" | "handoff" | "timeout";
  crm: "success" | "failure";
  slots: "available" | "none" | "race_lost";
  bookingIdentity: "verified" | "unverified";
  bookingLookup: "found" | "missing";
  journey: "success" | "failure";
};

export const DEFAULT_SIMULATOR_SCENARIO: SimulatorScenario = {
  ai: "answer",
  crm: "success",
  slots: "available",
  bookingIdentity: "verified",
  bookingLookup: "found",
  journey: "success",
};
