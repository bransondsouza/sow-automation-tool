export { default } from "next-auth/middleware";

// Everything under /upload and /status, and their API routes, requires sign-in.
// The landing page ("/") and the NextAuth routes stay public.
export const config = {
  matcher: [
    "/upload/:path*",
    "/status/:path*",
    "/drive-folders/:path*",
    "/dashboard/:path*",
    "/api/upload/:path*",
    "/api/status/:path*",
    "/api/drive-folders/:path*",
    "/api/dashboard/:path*",
  ],
};
