import SurveyForm from "@/components/SurveyForm";
import { loadFrozenSurveyResponse } from "@/lib/governedSurveyRuntime";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveSurveyResponseTenant } from "@/lib/tokenTenant";

export const dynamic = "force-dynamic";

function InvalidLink() {
  return (
    <div className="py-10 text-center">
      <div className="mb-3 text-4xl">🔗</div>
      <h1 className="mb-1 text-lg font-semibold">This link isn&apos;t valid</h1>
      <p className="text-slate-400">The survey may have been closed. Thanks anyway!</p>
    </div>
  );
}

export default async function SurveyPublicPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return withTokenTenantScope(
    () => resolveSurveyResponseTenant(token),
    () => renderSurveyPage(token),
    () => <InvalidLink />,
  );
}

async function renderSurveyPage(token: string) {
  const response = await loadFrozenSurveyResponse(token);
  if (!response) return <InvalidLink />;
  const survey = response.snapshot;

  if (response.status === "completed") {
    return (
      <div className="py-10 text-center">
        <div className="mb-3 text-4xl">✅</div>
        <h1 className="mb-1 text-lg font-semibold">You&apos;ve already answered this</h1>
        <p className="text-slate-400">{survey.thankYou || "Thank you — your feedback has been received."}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-[-0.035em]">{survey.title}</h1>
      <SurveyForm token={token} intro={survey.intro} thankYou={survey.thankYou} questions={survey.questions} />
    </div>
  );
}
