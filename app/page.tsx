import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/authOptions";
import { SignInButton, SignOutButton } from "./AuthButtons";
import Link from "next/link";

export default async function HomePage() {
  const session = await getServerSession(authOptions);

  return (
    <main>
      <div className="card">
        <h1>SOW Automation Tool</h1>
        <p className="subtitle">
          Upload a Statement of Work and get a client-ready pitch deck in
          minutes — no formatting required.
        </p>

        {session ? (
          <>
            <p>
              Signed in as <strong>{session.user?.email}</strong>
            </p>
            <Link href="/upload" className="btn">
              Go to Upload →
            </Link>
            <Link href="/dashboard" className="btn" style={{ marginLeft: 12, background: "var(--surface)", color: "var(--primary)", border: "1px solid var(--border)" }}>
              Open Dashboard →
            </Link>
            <div style={{ marginTop: 16 }}>
              <SignOutButton />
            </div>
            {session.error === "RefreshAccessTokenError" && (
              <div className="error-box">
                Your Google session expired. Please sign out and sign back in.
              </div>
            )}
          </>
        ) : (
          <SignInButton />
        )}
      </div>
    </main>
  );
}
