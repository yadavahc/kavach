import type { Metadata } from "next";
import { BenchApp } from "@/components/bench/BenchApp";

export const metadata: Metadata = {
  title: "Eval bench & latency A/B · Kavach",
  description: "Replay labelled scam and benign calls through the live pipeline and compare on-device Moss retrieval against a simulated hosted vector database.",
};

export default function BenchPage() {
  return <BenchApp />;
}
