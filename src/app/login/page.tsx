import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import LoginForm from "./LoginForm";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

type LoginPageProps = {
  searchParams?: Promise<{
    next?: string;
  }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const authed = await verifySessionToken(token);
  const next = (await searchParams)?.next;

  if (authed) {
    redirect(next && next.startsWith("/") ? next : "/");
  }

  return <LoginForm />;
}
