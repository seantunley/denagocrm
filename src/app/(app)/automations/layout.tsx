import Link from "next/link";
import { CheckSquare, ListRestart, MoveRight, Route, Workflow } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";

const links = [
  { href: "/automations", label: "Quick rules", icon: Workflow },
  { href: "/journeys", label: "Journeys", icon: Route },
  { href: "/automations/approvals", label: "Approvals", icon: CheckSquare },
  { href: "/automations/outbox", label: "Action queue", icon: ListRestart },
  { href: "/automations/transfers", label: "Stock transfers", icon: MoveRight },
];

export default function AutomationLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-5">
      <nav className="flex flex-wrap gap-2" aria-label="Automation platform">
        {links.map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href} className={buttonVariants({ variant: "secondary", size: "sm" })}>
            <Icon className="size-4" />{label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
