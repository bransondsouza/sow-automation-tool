import crypto from "crypto";
import { supabaseAdmin } from "./supabase";

// AES-256-GCM encryption for the one long-lived Google credential this app
// stores server-side: a refresh token per person, in the
// user_google_tokens table (see supabase/schema.sql). It exists for exactly
// one purpose — the unattended daily alert check
// (app/api/cron/daily-alerts) needs to read someone's tracker sheets and
// send email/Chat alerts with nobody's browser open. Every other feature in
// this app reads Google APIs live using the signed-in person's own session
// token, which is never written to disk.
//
// TOKEN_ENCRYPTION_KEY must be a 32-byte key, base64-encoded. Generate one
// with: openssl rand -base64 32
// Deliberately its own secret — never reuse NEXTAUTH_SECRET or any other
// existing secret for this.

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // recommended length for GCM

function getKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("TOKEN_ENCRYPTION_KEY is not configured.");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (base64-encoded).");
  }
  return key;
}

// Stored as "iv:authTag:ciphertext", each base64 — self-contained, so
// decrypt() needs nothing but the key and this one string.
function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

function decrypt(stored: string): string {
  const key = getKey();
  const [ivB64, authTagB64, ciphertextB64] = stored.split(":");
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("Stored token is not in the expected iv:authTag:ciphertext format.");
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]);
  return plaintext.toString("utf8");
}

/**
 * Encrypts and upserts a person's Google refresh token, keyed by their
 * email. Called on every sign-in (see the jwt callback in
 * lib/authOptions.ts) so the daily alert cron always has a current token
 * for anyone who has signed in at least once since this feature shipped.
 * Deliberately best-effort from the caller's side — a Supabase or
 * encryption hiccup here should never block someone signing in.
 */
export async function persistRefreshToken(userEmail: string, refreshToken: string): Promise<void> {
  const encrypted = encrypt(refreshToken);
  const { error } = await supabaseAdmin
    .from("user_google_tokens")
    .upsert({ user_email: userEmail, encrypted_refresh_token: encrypted }, { onConflict: "user_email" });
  if (error) throw error;
}

/** Reads and decrypts the stored refresh token for a person, if any. */
export async function getStoredRefreshToken(userEmail: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("user_google_tokens")
    .select("encrypted_refresh_token")
    .eq("user_email", userEmail)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return decrypt(data.encrypted_refresh_token);
}

export interface ExchangedToken {
  accessToken: string;
  expiresIn: number;
  refreshToken?: string;
}

/**
 * Trades a refresh token for a fresh access token against Google's OAuth
 * endpoint. Shared by the browser-session refresh path
 * (lib/authOptions.ts's refreshAccessToken) and the unattended cron path
 * (app/api/cron/daily-alerts), so there's exactly one place in this app
 * that knows how to talk to Google's token endpoint.
 */
export async function exchangeRefreshToken(refreshToken: string): Promise<ExchangedToken> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const body = await response.json();
  if (!response.ok) throw body;

  return {
    accessToken: body.access_token,
    expiresIn: body.expires_in,
    // Google doesn't always send back a new refresh token on a refresh —
    // callers should keep the old one when this comes back undefined.
    refreshToken: body.refresh_token,
  };
}
