"use client";

import { signIn, signOut } from "next-auth/react";

export function SignInButton() {
  return (
    <button onClick={() => signIn("google", { callbackUrl: "/upload" })}>
      Sign in with Google
    </button>
  );
}

export function SignOutButton() {
  return (
    <button onClick={() => signOut({ callbackUrl: "/" })} style={{ background: "#6b7280" }}>
      Sign out
    </button>
  );
}
