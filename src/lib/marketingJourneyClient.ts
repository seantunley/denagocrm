export const JOURNEY_TRIGGERS = [
  "lead_created",
  "stage_entered",
  "lead_won",
  "lead_lost",
  "quote_signed",
  "quote_declined",
  "delivered",
  "referral_earned",
  "lead_idle",
  "purchase_anniversary",
  "winback",
] as const;

export type JourneyTrigger = (typeof JOURNEY_TRIGGERS)[number];

export type JourneyCondition = {
  field: string;
  operator: "eq" | "neq" | "contains" | "gt" | "gte" | "lt" | "lte" | "empty" | "not_empty" | "in";
  value?: unknown;
};

export type JourneyConditionGroup = {
  mode: "and" | "or";
  conditions: Array<JourneyCondition | JourneyConditionGroup>;
};

export type JourneyStep =
  | { type: "wait"; hours: number }
  | { type: "condition"; conditions: JourneyConditionGroup; onTrue: number; onFalse: number }
  | { type: "send_campaign"; campaignId: string }
  | { type: "send_email"; subject: string; body: string; transactional: boolean }
  | { type: "create_activity"; activityType: "call" | "email" | "meeting" | "whatsapp" | "todo"; summary: string; dueHours: number; assignToId?: string | null }
  | { type: "move_stage"; stageId: string }
  | { type: "assign_user"; userId: string }
  | { type: "add_tag"; tagId: string }
  | { type: "remove_tag"; tagId: string }
  | { type: "send_push"; title: string; body: string }
  | { type: "end"; reason?: string };

export type JourneyDefinition = {
  entryConditions?: JourneyConditionGroup;
  idleDays?: number;
  steps: JourneyStep[];
};
