import { prisma } from "@/lib/db";
import SurveyForm from "@/components/SurveyForm";
import { defaultIntro, type SurveyQuestion, type SurveyType } from "@/lib/surveyTypes";

export const dynamic = "force-dynamic";

export default async function SurveyPublicPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const resp = await prisma.surveyResponse.findUnique({
    where: { token },
    include: { survey: true },
  });
  const survey = resp?.survey;

  if (!resp || !survey || survey.deletedAt) {
    return (
      <div className="text-center py-10">
        <div className="text-4xl mb-3">🔗</div>
        <h1 className="text-lg font-semibold mb-1">This link isn&apos;t valid</h1>
        <p className="text-slate-400">The survey may have been closed. Thanks anyway!</p>
      </div>
    );
  }

  if (resp.status === "completed") {
    return (
      <div className="text-center py-10">
        <div className="text-4xl mb-3">✅</div>
        <h1 className="text-lg font-semibold mb-1">You&apos;ve already answered this</h1>
        <p className="text-slate-400">
          {survey.thankYou || "Thank you — your feedback has been received."}
        </p>
      </div>
    );
  }

  const questions = (survey.questions as unknown as SurveyQuestion[]) ?? [];
  const intro = survey.intro || defaultIntro(survey.type as SurveyType);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{survey.title}</h1>
      <SurveyForm
        token={token}
        intro={intro}
        thankYou={survey.thankYou}
        questions={questions}
      />
    </div>
  );
}
