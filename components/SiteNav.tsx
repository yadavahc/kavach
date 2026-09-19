import Link from "next/link";
import type { ReactNode } from "react";

const LINKS = [
  { href: "/live", label: "Live" },
  { href: "/bench", label: "Eval bench & A/B" },
  { href: "/#architecture", label: "Architecture" },
];

export function SiteNav({ active, children }: { active?: string; children?: ReactNode }) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-ink/95">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-fg">
          <ShieldMark />
          Kavach Live
        </Link>
        <nav className="flex gap-4 text-[13px]">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className={active === l.href ? "text-fg" : "text-muted hover:text-fg"}>
              {l.label}
            </Link>
          ))}
        </nav>
        {children && <div className="ml-auto min-w-0">{children}</div>}
      </div>
    </header>
  );
}

export function ShieldMark({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M12 2.5 4 5.5v6.2c0 4.8 3.3 8.7 8 9.8 4.7-1.1 8-5 8-9.8V5.5l-8-3Z" fill="none" stroke="var(--color-shield)" strokeWidth="1.6" />
      <path d="M7.5 12.2h2l1.3-3 2.4 6 1.3-3h2" fill="none" stroke="var(--color-danger)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
