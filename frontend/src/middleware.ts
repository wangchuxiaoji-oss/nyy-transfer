import { NextResponse, type NextRequest } from "next/server";

const adminPath = process.env.NEXT_PUBLIC_ADMIN_PATH || "/nyy-console";

export function middleware(request: NextRequest) {
  if (adminPath !== "/nyy-console" && request.nextUrl.pathname === adminPath) {
    return NextResponse.rewrite(new URL("/nyy-console", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
