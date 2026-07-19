import SettingsModal from "@/components/SettingsModal";
import SettingsPage from "@/app/(app)/settings/page";

// Intercepts /settings (and its ?tab= variants) into a modal on client-side
// navigation from the sidebar Settings flyout. Direct URL / refresh renders the
// full page instead.
const Content = SettingsPage as unknown as (props: Record<string, unknown>) => React.ReactNode;

export default function InterceptedSettings(props: Record<string, unknown>) {
  return (
    <SettingsModal>
      <Content {...props} />
    </SettingsModal>
  );
}
