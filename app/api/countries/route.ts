import { NextResponse } from "next/server";
import { getSupportedCountries } from "@/lib/holidays";

export const runtime = "nodejs";

// Public on purpose — this just lists countries, nothing user-specific.
// Powers the Upload form's "exclude holidays of" picker.
export async function GET() {
  return NextResponse.json({ countries: getSupportedCountries() });
}
