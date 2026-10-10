/**
 * The answer to "is this the document that was signed?".
 *
 * Its own file, with no imports, because both sides need it: the server builds
 * it (verifyDocument.ts, which reaches the database) and a client component
 * renders it. A client component must not import from a server module even for
 * a type — the same reason actionResultTypes.ts sits apart from actionResult.ts.
 *
 * It names the workspace that sealed the document, when, and how many people
 * signed: what the holder can already read in the file. It names nobody.
 */
export type DocumentVerdict =
  | {
      genuine: true;
      /** The company that sealed it. */
      sealedBy: string;
      title: string;
      /** When it was sealed, in that company's own time zone. */
      sealedAt: string;
      timeZone: string;
      signers: number;
      /** An independent authority's time-stamp exists for this exact file, and still verifies. */
      timestamped: boolean;
    }
  | { genuine: false };

export const NOT_GENUINE: DocumentVerdict = { genuine: false };
