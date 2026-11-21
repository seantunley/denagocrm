import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell, PrivacyContact } from "../LegalShell";
import { PLATFORM } from "@/lib/platformLegal";

export const metadata: Metadata = { title: `Privacy policy — ${PLATFORM.name}`, robots: { index: false } };

export default function PrivacyPage() {
  const name = PLATFORM.name;
  return (
    <LegalShell title="Privacy policy">
      <p>
        {name} is a customer relationship management (CRM) platform used by independent businesses. Each business has its
        own private workspace. This policy explains what information {name} handles, why, and the choices people have.
      </p>

      <h2>Who is responsible</h2>
      <p>
        Each business that uses {name} decides what information it keeps about its own customers and how it uses it — it is
        the responsible party for that information. {name} processes that information on the business&apos;s behalf, only
        to provide the service. For questions about a specific business&apos;s use of your information, contact that business.
        For questions about {name} itself, contact us (details below).
      </p>

      <h2>Information we handle</h2>
      <ul>
        <li><b>Business users:</b> name, email address, phone number and sign-in details of the staff a business invites.</li>
        <li><b>Customer records a business keeps:</b> contact details, notes, quotes, documents and messages.</li>
        <li>
          <b>From connected Facebook, Instagram and WhatsApp accounts</b> (only when a business connects its own account):
          the Page or account&apos;s id and name and the access token Meta issues for it; messages, comments and lead-form
          submissions sent to that business; and the name and id Meta provides for the people who send them, with any
          attachments.
        </li>
        <li><b>Technical information:</b> logs needed to keep the service secure and working.</li>
      </ul>

      <h2>How it is used</h2>
      <ul>
        <li>To show a business its own messages, comments and leads, and let its staff reply from the CRM.</li>
        <li>To run the automations a business switches on for itself, such as chatbot replies and reminders.</li>
        <li>
          When a business uses the built-in AI assistant, the relevant text may be sent to an AI service provider to produce
          an answer or a draft.
        </li>
        <li>To keep the service secure, fix problems and meet legal obligations.</li>
      </ul>
      <p>
        We do not sell personal information, do not use it for advertising, and never share one business&apos;s
        information with another business on the platform.
      </p>

      <h2>Service providers</h2>
      <p>
        {name} uses carefully chosen providers to run the service: cloud hosting and file storage (Vercel), a managed
        database (Neon), and — only when a business uses those features — AI providers (OpenAI, Anthropic, ElevenLabs) and
        the messaging platforms the business connects (Meta). Some of these providers store or process information outside
        South Africa, under their own security and data-protection commitments.
      </p>

      <h2>Security</h2>
      <p>
        Information travels over encrypted connections. Access tokens and passwords for connected services are encrypted
        when stored. Every business&apos;s workspace is kept separate at the database level, and staff see only what their
        role in that business allows.
      </p>

      <h2>How long information is kept</h2>
      <p>
        Information is kept while the business uses {name}. Items a business deletes go to a recycle bin for 60 days and are
        then removed. When a business disconnects a Facebook, Instagram or WhatsApp account, its access token is deleted
        straight away.
      </p>

      <h2>Your rights</h2>
      <p>
        Under the Protection of Personal Information Act (POPIA) and similar laws you may ask to see, correct or delete
        information about you, or object to its use. If you are a customer of a business that uses {name}, please contact
        that business first. You can also write to us at <PrivacyContact />, and you may complain to the Information
        Regulator of South Africa.
      </p>

      <h2>Deleting data connected through Facebook</h2>
      <p>
        See <Link className="underline" href="/legal/data-deletion">Data deletion</Link> for how to remove {name}&apos;s
        access and have the related data deleted.
      </p>

      <h2>Changes</h2>
      <p>We will update this page if this policy changes, with a new effective date.</p>
    </LegalShell>
  );
}
