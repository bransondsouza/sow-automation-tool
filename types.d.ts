import "next-auth";
import "next-auth/jwt";

// Extends NextAuth's built-in types so TypeScript knows about the extra
// fields we attach in lib/authOptions.ts (the Google access token, etc.).

declare module "next-auth" {
  interface Session {
    accessToken?: string;
    error?: string;
    user?: {
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string;
    refreshToken?: string;
    accessTokenExpires?: number;
    error?: string;
  }
}
