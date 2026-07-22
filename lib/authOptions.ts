import { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";

// These are the Google permissions the app asks each employee to grant when
// they sign in. Every one of them is required for a feature described in the
// spec: Slides (pitch deck), Sheets (tracker), Drive (copying arbitrary
// templates, creating folders inside arbitrary parent folders), and Chat
// (Phase 4 notifications).
//
// Note on the Drive scope: the narrower "drive.file" scope only lets the app
// touch files IT created. Phase 1 lets an employee paste a link to an
// existing Slides template, and Phase 2 lets them paste a link to an
// existing parent Drive folder — neither of those was created by the app, so
// drive.file can't reach them (Drive API returns 404). Full "drive" scope is
// required to support "paste any link" instead of forcing everyone through a
// Google Drive file picker. Because this is an internal company tool (the
// OAuth consent screen is "Internal" once you're on the company Workspace,
// or "Testing" with named test users on personal Gmail), this broad scope
// does not require Google's public security-assessment review. Every action
// still runs as the signed-in employee's own identity and is limited to
// whatever that employee can already see in their own Drive — the app never
// uses a shared service-account credential.
// script.projects lets the app install the "Generate Project Tracker" menu
// (a container-bound Apps Script) onto each spreadsheet it creates. This
// requires the Apps Script API to be enabled in Google Cloud, AND every
// employee who generates a tracker to have "Google Apps Script API" access
// turned on for their own account at script.google.com/home/usersettings
// (off by default) — see DEPLOYMENT_GUIDE.md. If either is missing, the
// spreadsheet still generates fine; only the in-sheet button is skipped.
//
// gmail.send (Phase 4) lets the app send the "Generate Client Status
// Report" email as the signed-in employee's own Gmail — not a shared
// mailbox — and only ever composes a *new* message; it cannot read, list,
// or search anything already in that person's mailbox. Requires the Gmail
// API enabled in Google Cloud (see DEPLOYMENT_GUIDE.md). Anyone who signed
// in before this scope was added needs to sign out and back in once to
// re-consent — until then, the email step of a status report fails
// non-fatally (the Slides deck and Chat message still go out).
//
// Note: the Phase 4 Chat notification does NOT use an OAuth scope. It posts
// to a plain incoming webhook URL (a per-space credential you create in
// Google Chat itself) instead of the Chat API, specifically so this list
// doesn't need a chat.* scope at all — one fewer permission every employee
// has to consent to.
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/script.projects",
  "https://www.googleapis.com/auth/gmail.send",
].join(" ");

interface RefreshableToken {
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpires?: number;
  error?: string;
  [key: string]: unknown;
}

// Google access tokens expire after ~1 hour. If a job is still running (or a
// new one starts) after that, use the refresh token to get a new one instead
// of forcing the employee to sign in again.
async function refreshAccessToken(token: RefreshableToken): Promise<RefreshableToken> {
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        grant_type: "refresh_token",
        refresh_token: token.refreshToken ?? "",
      }),
    });

    const refreshed = await response.json();
    if (!response.ok) throw refreshed;

    return {
      ...token,
      accessToken: refreshed.access_token,
      accessTokenExpires: Date.now() + refreshed.expires_in * 1000,
      // Google doesn't always send back a new refresh token — keep the old one.
      refreshToken: refreshed.refresh_token ?? token.refreshToken,
      error: undefined,
    };
  } catch (error) {
    console.error("Failed to refresh Google access token:", error);
    return { ...token, error: "RefreshAccessTokenError" };
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      authorization: {
        params: {
          scope: GOOGLE_SCOPES,
          access_type: "offline", // required to receive a refresh_token
          prompt: "consent", // forces Google to re-issue a refresh_token every sign-in
        },
      },
    }),
  ],
  secret: process.env.NEXTAUTH_SECRET,
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, account }) {
      // First sign-in: persist the tokens Google just issued.
      if (account) {
        return {
          ...token,
          accessToken: account.access_token,
          refreshToken: account.refresh_token,
          accessTokenExpires: account.expires_at ? account.expires_at * 1000 : 0,
        } as RefreshableToken;
      }

      const current = token as RefreshableToken;

      // Still valid — reuse it.
      if (current.accessTokenExpires && Date.now() < current.accessTokenExpires) {
        return current;
      }

      // Expired — refresh it.
      return refreshAccessToken(current);
    },
    async session({ session, token }) {
      const t = token as RefreshableToken;
      session.accessToken = t.accessToken;
      session.error = t.error;
      return session;
    },
  },
  pages: {
    signIn: "/",
  },
};
