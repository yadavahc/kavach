import type { Metadata } from "next";
import { LiveApp } from "@/components/live/LiveApp";

export const metadata: Metadata = {
  title: "Live · Kavach",
  description: "Live scam-call interception: on-device transcript retrieval, claim checks, coercion pressure and an evidence pack.",
};

export default function LivePage() {
  return <LiveApp />;
}
