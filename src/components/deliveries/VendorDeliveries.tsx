import { SaveForm, SaveButton } from "@/components/SaveForm";
import { setVendorDeliveryStatus, type BookingTarget } from "@/app/actions/vendorDeliveries";
import { deliveryStatusLabel, nextDeliveryStatuses } from "@/lib/vendorDeliveryRules";
import { formatDate } from "@/lib/format";
import BookDeliveryForm, { type BookingVendor } from "./BookDeliveryForm";

export type BookingRow = { id: string; status: string; scheduledFor: Date; sentTo: string; vendor: { name: string } };

const TONE: Record<string, string> = {
  requested: "text-amber-300",
  confirmed: "text-sky-300",
  collected: "text-violet-300",
  delivered: "text-emerald-300",
  cancelled: "text-muted-foreground line-through",
};

/**
 * The delivery bookings on a deal or a purchase order, each with the next step to press as the supplier reports
 * back, then "Book delivery". `charge`: the delivery line already on the quote — the booking's cost (no second
 * cost field, Sean 2026-11-09).
 */
export default function VendorDeliveries({ target, bookings, vendors, defaults, charge, canManage }: {
  target: BookingTarget;
  bookings: BookingRow[];
  vendors: BookingVendor[];
  defaults: { date: string; from: string; to: string };
  charge?: string | null;
  canManage: boolean;
}) {
  return (
    <div className="mt-2 space-y-1.5 text-xs">
      {bookings.map((booking) => (
        <div key={booking.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-foreground">{booking.vendor.name}</span>
          <span className="text-muted-foreground">{formatDate(booking.scheduledFor)}</span>
          <span className={TONE[booking.status] ?? ""}>{deliveryStatusLabel(booking.status)}</span>
          {canManage && nextDeliveryStatuses(booking.status).map((next) => (
            <SaveForm key={next} action={setVendorDeliveryStatus.bind(null, booking.id, next)} success={deliveryStatusLabel(next)}>
              <SaveButton className={`text-[11px] font-medium hover:underline ${next === "cancelled" ? "text-muted-foreground" : "text-primary"}`}>
                {next === "cancelled" ? "Cancel" : `Mark ${deliveryStatusLabel(next).toLowerCase()}`}
              </SaveButton>
            </SaveForm>
          ))}
        </div>
      ))}
      {charge && <p className="text-[11px] text-muted-foreground">Delivery on the quote: {charge}</p>}
      {canManage && <BookDeliveryForm target={target} vendors={vendors} defaults={defaults} />}
    </div>
  );
}
