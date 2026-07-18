import { cookies } from "next/headers";
import DevLoginForm from "@/components/DevLoginForm";
import DevPanelClient from "@/components/DevPanelClient";
import { COOKIE_NAME, verifySessionToken } from "@/lib/dev-auth";

export const dynamic = "force-dynamic";

export default async function DevPage() {
  const cookieStore = await cookies();
  const authed = verifySessionToken(cookieStore.get(COOKIE_NAME)?.value);

  return (
    <div className="mx-auto w-full max-w-md px-4 py-10">
      <h1 className="animate-in mb-6 text-2xl font-bold text-foreground">Developer Panel</h1>
      <div className="panel animate-in-delay-1 p-6">
        {authed ? <DevPanelClient /> : <DevLoginForm />}
      </div>
    </div>
  );
}
