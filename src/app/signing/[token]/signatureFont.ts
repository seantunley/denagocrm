import { Dancing_Script } from "next/font/google";

/**
 * The script face a TYPED signature is set in.
 *
 * Served from our own origin (next/font downloads it at build time), so signing
 * never waits on, or tells, a third party. Not preloaded: most signers draw, and
 * the file is only fetched the first time someone chooses to type.
 */
export const signatureFont = Dancing_Script({ subsets: ["latin"], weight: "600", display: "swap", preload: false });
