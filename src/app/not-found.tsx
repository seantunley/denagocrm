import NotFoundScreen from "@/components/NotFoundScreen";

/**
 * A URL that matches no page, and every notFound() outside the signed-in app — customers' signing, handover and
 * approval links included. Neutral on purpose (NotFoundScreen). Root layout: no sidebar, the app's own background.
 */
export default function RootNotFound() {
  return (
    <main className="min-h-dvh bg-background">
      <NotFoundScreen inApp={false} />
    </main>
  );
}
