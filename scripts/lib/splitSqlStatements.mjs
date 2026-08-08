// Split a migration.sql into individual statements.
//
// WHY THIS EXISTS
//
// The migration runner used to hand each file to `npx prisma db execute`, which
// costs ~1.4s of Node + CLI startup per migration. With 180 migrations that is
// roughly four minutes of a CI run spent starting processes rather than running
// SQL. Executing the statements from the runner's own Prisma client removes the
// spawn entirely — but that client's `$executeRawUnsafe` speaks the extended
// query protocol, which carries exactly ONE statement per round trip. So the
// file has to be split, and the split has to be correct.
//
// "Correct" is doing real work here. 412 of these statements sit inside
// dollar-quoted PL/pgSQL bodies whose internal semicolons must NOT split, and
// the corpus uses four distinct named tags ($sql$, $backfill$, …) alongside the
// anonymous $$, so matching on "$$" alone mis-parses them. Three files use E''
// escape strings containing backslash escapes, doubled '' quotes, and a stray
// `$DATABASE_URL_UNPOOLED` that must not be read as the start of a dollar quote.
//
// A splitter that gets this wrong does not fail loudly. It cuts a PL/pgSQL body
// in half and applies the fragments, or swallows a statement into a string and
// silently never runs it — the "recorded as applied but the SQL never ran" shape
// that took production's login down in July. That is why this is a separate,
// pure, exported module with its own tests rather than a regex in the runner.
//
// The rules implemented below are PostgreSQL's lexical structure:
//   'text'         single-quoted string; '' is an escaped quote; backslash is
//                  literal (standard_conforming_strings, on by default)
//   E'text'        escape string; backslash IS an escape, so \' does not end it
//   "ident"        quoted identifier; "" is an escaped quote
//   $tag$text$tag$ dollar-quoted string; tag may be empty; anything inside is
//                  literal, including semicolons and other quote characters
//   --             line comment, to end of line
//   /* */          block comment, and unlike most dialects these NEST
//   ;              statement separator, but only outside all of the above

/** Characters that may appear in an identifier, for E'' disambiguation. */
function isIdentChar(ch) {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

/**
 * A dollar-quote opener at `i`, or null.
 *
 * The tag may not start with a digit, which is what keeps positional parameters
 * ($1, $2) from being read as quote openers. `$DATABASE_URL_UNPOOLED"` is
 * likewise not an opener: there is no closing $ before the quote.
 */
function dollarQuoteAt(sql, i) {
  if (sql[i] !== "$") return null;
  let j = i + 1;
  while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) {
    // A tag cannot begin with a digit.
    if (j === i + 1 && /[0-9]/.test(sql[j])) return null;
    j++;
  }
  return sql[j] === "$" ? sql.slice(i, j + 1) : null;
}

/**
 * Split `sql` into executable statements.
 *
 * Statements are returned trimmed, in order, with comment-only and empty
 * fragments dropped — `$executeRawUnsafe` on a comment is an empty query, which
 * some drivers reject and none of which we want to send.
 *
 * Comments attached to a statement are PRESERVED inside it. They are not
 * stripped: a migration's comments frequently explain a guard clause, and the
 * server ignores them anyway.
 *
 * @param {string} sql
 * @returns {string[]}
 */
export function splitSqlStatements(sql) {
  const statements = [];
  const n = sql.length;
  let start = 0;
  let i = 0;
  let sawCode = false; // any non-comment, non-whitespace content since `start`

  const push = (end) => {
    if (sawCode) {
      const text = sql.slice(start, end).trim();
      if (text) statements.push(text);
    }
    sawCode = false;
  };

  while (i < n) {
    const ch = sql[i];

    // -- line comment
    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }

    // /* block comment */ — nestable
    if (ch === "/" && sql[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }

    // $tag$ dollar-quoted body — checked before anything else that could be
    // confused by its contents, because everything inside is literal.
    const tag = dollarQuoteAt(sql, i);
    if (tag) {
      sawCode = true;
      const close = sql.indexOf(tag, i + tag.length);
      // An unterminated body is left to the server to reject, with the original
      // text intact, rather than guessed at here.
      i = close === -1 ? n : close + tag.length;
      continue;
    }

    // E'escape string' — only when E is not the tail of an identifier, so
    // `LIKE'x'` (valid, no space required) is not read as an escape string.
    if ((ch === "E" || ch === "e") && sql[i + 1] === "'" && !isIdentChar(sql[i - 1])) {
      sawCode = true;
      i += 2;
      while (i < n) {
        if (sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // 'string' and "identifier" — same doubling rule, no backslash escapes.
    if (ch === "'" || ch === '"') {
      sawCode = true;
      i++;
      while (i < n) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === ";") {
      push(i);
      i++;
      start = i;
      continue;
    }

    if (!/\s/.test(ch)) sawCode = true;
    i++;
  }

  // Trailing statement with no final semicolon.
  push(n);
  return statements;
}
