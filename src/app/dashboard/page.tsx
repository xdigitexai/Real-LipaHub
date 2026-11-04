import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/session-server";

export default async function DashboardRouter() {
  const ctx = await getAuthContext();
  if (!ctx) redirect("/login");
  switch (ctx.role) {
    case "ADMIN": redirect("/admin"); break;
    case "BUSINESS": redirect("/business"); break;
    case "WORKER": redirect("/worker"); break;
  }
}
