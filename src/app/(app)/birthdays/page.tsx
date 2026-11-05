import Link from "next/link";
import { Cake, MessageCircle, Phone } from "lucide-react";
import { requireRoute } from "@/lib/permissions";
import { birthdaysOn } from "@/lib/birthdaysServer";
import { formatBirthday, nextDays, saDate, turningAge } from "@/lib/birthdays";
import { contactName } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/visual-system";

export const dynamic = "force-dynamic";

/**
 * Customer birthdays: today, the next seven days, and the rest of this month — only customers you may open. Nothing
 * is sent from here: wishing someone well is your own message, from their page.
 */
export default async function BirthdaysPage() {
  // The same rule the proxy applies to /birthdays (routeAccess.ts), so the edge and the page can't disagree.
  const user = await requireRoute("/birthdays");
  const today = saDate();
  const week = nextDays(7, 1);
  // The rest of this month, after the coming week.
  const restOfMonth = nextDays(31, 8).filter((d) => d.month === today.month && d.year === today.year);
  // Each list comes back in day order (December before January across New Year), with its true total.
  const [todays, coming, later] = await Promise.all([
    birthdaysOn(user, nextDays(1)),
    birthdaysOn(user, week),
    birthdaysOn(user, restOfMonth),
  ]);

  const section = (title: string, { rows, total }: Awaited<ReturnType<typeof birthdaysOn>>, empty: string) => (
    <div className="card space-y-3 p-4">
      <h2 className="font-semibold">{title} <span className="font-normal text-muted-foreground">({total})</span></h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((c) => {
            const age = turningAge(c, today.year + (c.birthMonth! < today.month ? 1 : 0));
            const phone = c.whatsapp ?? c.phone;
            return (
              <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-sm">
                <Link href={`/contacts/${c.id}`} className="font-medium text-primary hover:underline">{contactName(c)}</Link>
                <span className="text-muted-foreground">{formatBirthday({ ...c, birthYear: null })}{age ? ` · turns ${age}` : ""}</span>
                {c.owner && <span className="text-xs text-muted-foreground">Owner: {c.owner.name}</span>}
                <span className="ml-auto flex gap-3 text-xs">
                  {phone && <a href={`tel:${phone}`} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"><Phone className="size-3.5" />{phone}</a>}
                  <Link href={`/contacts/${c.id}`} className="inline-flex items-center gap-1 text-primary hover:underline"><MessageCircle className="size-3.5" />Wish them</Link>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {total > rows.length && (
        <p className="text-xs text-muted-foreground">Showing the first {rows.length} of {total}, in date order. Search a customer by name to find one not shown.</p>
      )}
    </div>
  );

  const none = todays.total + coming.total + later.total === 0;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Birthdays"
        description="Your customers' birthdays — only the customers you can open. Add a birthday on the customer's form. Nothing is sent automatically: wish them yourself from their page."
      />
      {none ? (
        <EmptyState icon={Cake} title="No birthdays coming up this month" description="Add birthdays on your customers' forms (Edit → Birthday) and they'll show here, and on the cake in the top bar on the day." />
      ) : (
        <>
          {section("Today", todays, "No customer birthdays today.")}
          {section("Next 7 days", coming, "None in the coming week.")}
          {section("Later this month", later, "No more this month.")}
        </>
      )}
    </div>
  );
}
