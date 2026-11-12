import {
  Bot,
  Building2,
  Database,
  FilePen,
  Mail,
  Server,
  SlidersHorizontal,
  UserRound,
  UsersRound,
  Wrench,
  type LucideIcon,
} from "lucide-react";

/** One icon per settings group (lib/settings-navigation.ts) — the home cards and the sidebar's Settings panel. */
export const SETTINGS_GROUP_ICONS: Record<string, LucideIcon> = {
  "My account": UserRound,
  Business: Building2,
  "People & access": UsersRound,
  Sales: SlidersHorizontal,
  Records: Database,
  "Workshop & stock": Wrench,
  Messaging: Mail,
  "Documents & signing": FilePen,
  "Automation & AI": Bot,
  System: Server,
};
