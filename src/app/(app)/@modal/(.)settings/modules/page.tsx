import SettingsModal from "@/components/SettingsModal";
import Page from "@/app/(app)/settings/modules/page";

const Content = Page as unknown as (props: Record<string, unknown>) => React.ReactNode;

export default function InterceptedSettings(props: Record<string, unknown>) {
  return (
    <SettingsModal>
      <Content {...props} />
    </SettingsModal>
  );
}
