"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  GitBranch,
  UserCheck,
  Database,
} from "lucide-react";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/pipeline", label: "Pipeline", icon: GitBranch },
  { href: "/hitl", label: "HITL Review", icon: UserCheck },
  { href: "/memory", label: "Memory", icon: Database },
] as const;

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-[220px] shrink-0 border-r border-[#1c2333] bg-[#06080f]/95 backdrop-blur-md flex flex-col min-h-screen">
      <div className="p-4 border-b border-[#1c2333]">
        <p className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">
          Navigate
        </p>
      </div>
      <nav className="flex-1 p-3 space-y-1">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active =
            pathname === href || (href !== "/dashboard" && pathname.startsWith(href));
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors
                ${
                  active
                    ? "bg-cyan-500/15 text-cyan-300 border border-cyan-500/25"
                    : "text-gray-400 hover:bg-[#1c2333]/60 hover:text-gray-200 border border-transparent"
                }`}
            >
              <Icon size={18} className={active ? "text-cyan-400" : "text-gray-500"} />
              {label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
