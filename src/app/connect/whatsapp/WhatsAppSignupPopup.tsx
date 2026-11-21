"use client";

import { useEffect, useRef, useState } from "react";
import { SIGNUP_MESSAGE_TYPE, parseMetaSignupEvent, type SignupSession } from "@/lib/whatsappSignupMessage";

type FacebookSdk = {
  init: (options: Record<string, unknown>) => void;
  login: (callback: (response: { authResponse?: { code?: string } | null }) => void, options: Record<string, unknown>) => void;
};
declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

type Status = "loading" | "ready" | "working" | "done" | "cancelled" | "unsupported" | "failed" | "no-opener";

const WORDS: Record<Status, string> = {
  loading: "Loading Meta's sign-up…",
  ready: "Sign in with Facebook, choose or create your WhatsApp business account, and verify your number.",
  working: "Finish the steps in Meta's window…",
  done: "Done — returning you to Settings. You can close this window.",
  cancelled: "Sign-up was cancelled, so nothing was connected. You can try again.",
  unsupported: "That kind of number can't be connected here. Use a number that isn't on the WhatsApp Business app.",
  failed: "Meta didn't finish the sign-up, so nothing was connected. Press the button to try again.",
  "no-opener": "Open this from Settings → Integrations → WhatsApp in the CRM.",
};

/**
 * Meta's Embedded Signup (v4) in a popup on the platform's address. Meta's session event (the account and number ids)
 * and the login callback (the one-time code) both arrive here; only when BOTH have — Meta's FINISH, not a closed window
 * — is the result handed to the Settings page that opened this, at its exact origin. Closing Meta's window on its last
 * screen gives no code: that is "not connected", never a false success.
 */
export function WhatsAppSignupPopup({ appId, configId, version, state, returnOrigin }: { appId: string; configId: string; version: string; state: string; returnOrigin: string }) {
  const [status, setStatus] = useState<Status>("loading");
  const session = useRef<SignupSession | null>(null);

  useEffect(() => {
    if (!window.opener) {
      // window.opener exists only in the browser, after hydration — there is no earlier place to read it.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStatus("no-opener");
      return;
    }
    const onMessage = (event: MessageEvent) => {
      const result = parseMetaSignupEvent(event.origin, event.data);
      if (!result) return;
      if (result.kind === "finish") session.current = result.session;
      else setStatus(result.kind === "cancel" ? "cancelled" : result.kind === "unsupported" ? "unsupported" : "failed");
    };
    window.addEventListener("message", onMessage);
    window.fbAsyncInit = () => {
      window.FB?.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      setStatus("ready");
    };
    if (window.FB) window.fbAsyncInit();
    else if (!document.getElementById("facebook-jssdk")) {
      // Loaded by this (nonced) bundle, so the page's strict-dynamic script policy admits it.
      const script = document.createElement("script");
      script.id = "facebook-jssdk";
      script.src = "https://connect.facebook.net/en_US/sdk.js";
      script.async = true;
      script.crossOrigin = "anonymous";
      document.body.appendChild(script);
    }
    return () => window.removeEventListener("message", onMessage);
  }, [appId, version]);

  const start = () => {
    if (!window.FB) return setStatus("failed");
    session.current = null;
    setStatus("working");
    window.FB.login(
      (response) => {
        const code = response?.authResponse?.code;
        // Meta's session event can land just after the callback: wait for it briefly.
        const handOver = (tries: number) => {
          if (code && session.current) {
            window.opener?.postMessage({ type: SIGNUP_MESSAGE_TYPE, state, code, ...session.current }, returnOrigin);
            setStatus("done");
            setTimeout(() => window.close(), 1500);
          } else if (tries > 0) {
            setTimeout(() => handOver(tries - 1), 250);
          } else {
            setStatus((current) => (current === "working" ? (code ? "failed" : "cancelled") : current));
          }
        };
        handOver(20);
      },
      { config_id: configId, response_type: "code", override_default_response_type: true, extras: { setup: {} } },
    );
  };

  return (
    <div className="mt-4 space-y-4">
      <p className="text-sm">{WORDS[status]}</p>
      {(status === "ready" || status === "cancelled" || status === "failed") && (
        <button type="button" onClick={start} className="rounded-md bg-[#1877F2] px-4 py-2 text-sm font-semibold text-white">
          Continue with Facebook
        </button>
      )}
    </div>
  );
}
