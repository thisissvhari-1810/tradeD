import { H0H4Desk } from "@/components/fib-h0h4/h0h4-desk";
import { requirePageUser } from "@/server/guard";

export default async function FibH0H4Page() {
  await requirePageUser();
  return <H0H4Desk />;
}
