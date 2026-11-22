import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "../LegalShell";
import { PLATFORM } from "@/lib/platformLegal";

export const metadata: Metadata = { title: `Terms of service — ${PLATFORM.name}`, robots: { index: false } };

export default function TermsPage() {
  const name = PLATFORM.name;
  return (
    <LegalShell title="Terms of service">
      <p>
        These terms apply to businesses that use {name}, a customer relationship management (CRM) platform, and to the
        staff they invite. By using {name} you agree to them.
      </p>

      <h2>The service</h2>
      <p>
        {name} gives each business its own workspace to manage customers, sales, documents and conversations, and lets a
        business connect its own Facebook Page, Instagram account and WhatsApp number. Features may change as the service
        improves.
      </p>

      <h2>Your account</h2>
      <ul>
        <li>The business is responsible for the people it invites and what they do in its workspace.</li>
        <li>Keep sign-in details secret, and tell us promptly about any unauthorised use.</li>
      </ul>

      <h2>Your data</h2>
      <p>
        Information a business puts into {name} remains that business&apos;s. We use it only to provide the service, as
        described in the <Link className="underline" href="/legal/privacy">privacy policy</Link>.
      </p>

      <h2>Acceptable use</h2>
      <ul>
        <li>Use {name} lawfully, including privacy and consumer-protection law (such as POPIA).</li>
        <li>
          Message people only as the law and the messaging platforms allow — including Meta&apos;s and WhatsApp&apos;s
          policies, opt-in requirements and messaging windows.
        </li>
        <li>Do not send spam, attempt to access another business&apos;s data, or interfere with the service.</li>
      </ul>

      <h2>Connected platforms and their charges</h2>
      <p>
        Facebook, Instagram and WhatsApp are provided by Meta under Meta&apos;s own terms. Meta charges for some WhatsApp
        messages; those charges are billed by Meta directly to the business&apos;s own WhatsApp account.
      </p>

      <h2>Fees</h2>
      <p>Fees for {name} are as agreed with the business when it signs up.</p>

      <h2>Availability</h2>
      <p>
        We work to keep {name} available and secure, but cannot promise it will be uninterrupted or error-free. Services we
        rely on, including Meta&apos;s, can change or stop.
      </p>

      <h2>Ending the service</h2>
      <p>
        A business may stop using {name} at any time. We may suspend access that breaks these terms or puts others at risk.
        Disconnecting a Facebook, Instagram or WhatsApp account deletes its access token straight away.
      </p>

      <h2>Liability</h2>
      <p>
        To the extent the law allows, {name} is not liable for indirect or consequential losses, and our total liability is
        limited to the fees paid for the service in the three months before the claim.
      </p>

      <h2>Law</h2>
      <p>These terms are governed by the law of the Republic of South Africa.</p>

      <h2>Changes</h2>
      <p>We will update this page if these terms change, with a new effective date.</p>
    </LegalShell>
  );
}
