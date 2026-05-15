// Mock terminal command runner. Ported from cobweb-terminal.jsx.
// Will be replaced by real PTY-over-WebSocket when agent ships.

import type { Node } from "$lib/data/mock-nodes";
import { NODES, peerSummary } from "$lib/data/mock-nodes";
import type { TermLine } from "$lib/state/ui.svelte";

const MOTD_LINES_BY_OS: Record<string, TermLine[]> = {
  "macOS 14.4": [
    { kind: "sys", text: "Last login: Thu May 15 11:58:02 2026 from 10.144.0.1 (mesh)" },
  ],
  "Arch Linux": [
    { kind: "sys", text: "Linux nuc-arch 6.8.4-arch1-1 #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux" },
    { kind: "sys", text: "Last login: Thu May 15 09:14:11 2026 from 10.144.0.1" },
  ],
  "Debian 12": [
    {
      kind: "sys",
      text: "Linux aliyun-hk 6.1.0-13-cloud-amd64 #1 SMP Debian 6.1.55-1 (2026-03-12) x86_64",
    },
    {
      kind: "sys",
      text: "The programs included with the Debian GNU/Linux system are free software;",
    },
    { kind: "sys", text: "the exact distribution terms for each program are described in the" },
    { kind: "sys", text: "individual files in /usr/share/doc/*/copyright." },
    { kind: "sys", text: "" },
    { kind: "sys", text: "Last login: Thu May 15 06:22:48 2026 from 10.144.0.1" },
  ],
  "NixOS 24.05": [
    { kind: "sys", text: "Welcome to NixOS 24.05 (Uakari)" },
    { kind: "sys", text: "Last login: Thu May 15 11:42:08 2026 from 10.144.0.1" },
  ],
  "TrueNAS 13": [
    { kind: "sys", text: "FreeBSD 13.1-RELEASE-p9 GENERIC" },
    { kind: "sys", text: "Last login: Wed May 14 08:14:11 2026 from 10.144.0.1" },
  ],
  Raspbian: [
    { kind: "sys", text: "Linux rpi-edge 6.1.21-v8+ #1642 SMP PREEMPT aarch64 GNU/Linux" },
    { kind: "sys", text: "Last login: Thu May 15 11:38:02 2026 from 10.144.0.1" },
  ],
  "Proxmox VE 8": [
    { kind: "sys", text: "Linux proxmox-01 6.5.13-1-pve #1 SMP PREEMPT_DYNAMIC" },
    { kind: "sys", text: "Last login: Thu May 15 10:01:34 2026 from 10.144.0.1" },
  ],
  "Ubuntu 22.04": [
    { kind: "sys", text: "Welcome to Ubuntu 22.04.4 LTS (GNU/Linux 5.15.0-101-generic x86_64)" },
    { kind: "sys", text: "Last login: Wed May 14 23:11:51 2026 from 10.144.0.1" },
  ],
};

export function makeInitTerminalLines(node: Node, channel: "agent" | "ssh"): TermLine[] {
  const motd = MOTD_LINES_BY_OS[node.os] ?? [
    { kind: "sys", text: `Connected to ${node.host} (${node.os})` } as TermLine,
  ];
  const channelLine: TermLine =
    channel === "agent"
      ? { kind: "sys-dim", text: `[cobweb] channel: agent exec · 10.144.0.1 → ${node.host}` }
      : {
          kind: "sys-dim",
          text: `[cobweb] channel: ssh fallback · agent offline · 10.144.0.1 → ${node.host}`,
        };
  return [channelLine, ...motd];
}

export interface CommandResult {
  out: TermLine[];
  cwd: string;
  clear?: boolean;
  disconnect?: boolean;
  exit?: number;
}

export function runMockCommand(cmd: string, node: Node, cwd: string): CommandResult {
  const lines = (txt: string): TermLine[] => txt.split("\n").map((t) => ({ kind: "out", text: t }));
  const trimmed = cmd.trim();
  const argv = trimmed.split(/\s+/);
  const head = argv[0] || "";

  if (trimmed === "") return { out: [], cwd };
  if (head === "clear") return { out: [], cwd, clear: true };
  if (head === "exit" || head === "logout")
    return {
      out: [{ kind: "sys-dim", text: `Connection to ${node.host} closed.` }],
      cwd,
      disconnect: true,
    };

  if (head === "pwd") return { out: [{ kind: "out", text: cwd === "~" ? "/root" : cwd }], cwd };
  if (head === "whoami") return { out: [{ kind: "out", text: "root" }], cwd };
  if (head === "hostname") return { out: [{ kind: "out", text: node.host }], cwd };
  if (head === "uname") {
    if (argv.includes("-a"))
      return {
        out: [{ kind: "out", text: `Linux ${node.host} 6.1.0 #1 SMP x86_64 GNU/Linux` }],
        cwd,
      };
    return { out: [{ kind: "out", text: "Linux" }], cwd };
  }
  if (head === "uptime") {
    return {
      out: [
        {
          kind: "out",
          text: " 12:04:32 up 14 days,  3:21,  1 user,  load average: 0.18, 0.22, 0.20",
        },
      ],
      cwd,
    };
  }
  if (head === "date") {
    return { out: [{ kind: "out", text: "Thu May 15 12:04:34 CST 2026" }], cwd };
  }
  if (trimmed.startsWith("cat /etc/os-release")) {
    return {
      out: lines(
        `PRETTY_NAME="${node.os}"
NAME="${node.os.split(" ")[0]}"
VERSION_ID="${(node.os.match(/[\d.]+/) || ["1"])[0]}"
ID=${node.os.toLowerCase().split(" ")[0]}
HOME_URL="https://example.com/"
SUPPORT_URL="https://example.com/support"`,
      ),
      cwd,
    };
  }
  if (head === "ls") {
    return {
      out: [
        {
          kind: "out",
          text: "bin   boot  dev   etc   home  lib   mnt   opt   proc  root  run   sbin  srv   sys   tmp   usr   var",
        },
      ],
      cwd,
    };
  }
  if (head === "cd") {
    const target = argv[1] || "~";
    return {
      out: [],
      cwd: target === ".." ? cwd.split("/").slice(0, -1).join("/") || "~" : target,
    };
  }
  if (trimmed === "ip a" || trimmed === "ip addr") {
    return {
      out: lines(
        `1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN
    inet 127.0.0.1/8 scope host lo
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP
    link/ether 00:16:3e:08:bb:42 brd ff:ff:ff:ff:ff:ff
    inet 192.168.1.${10 + (node.id.length % 240)}/24 brd 192.168.1.255 scope global eth0
3: cobweb0: <POINTOPOINT,UP,LOWER_UP> mtu 1420 qdisc noqueue state UNKNOWN
    inet ${node.ip}/24 scope global cobweb0`,
      ),
      cwd,
    };
  }
  if (head === "ps") {
    return {
      out: lines(
        `  PID TTY          TIME CMD
    1 ?        00:00:08 systemd
  412 ?        00:00:02 sshd
 4821 ?        00:02:14 easytier
 5012 ?        00:00:42 ethub
 8821 pts/0    00:00:00 ps`,
      ),
      cwd,
    };
  }
  if (head === "easytier-cli" || head === "easytier") {
    if (argv[1] === "show" && argv[2] === "peers") {
      const peers = peerSummary(node).slice(0, 8);
      const header = "PEER          REGION    RTT     LOSS    TUNNEL";
      const rows = peers.map((p) => {
        const rtt = p.ms < 0 ? "×" : `${p.ms}ms`;
        const loss = p.loss < 0 ? "×" : `${p.loss.toFixed(1)}%`;
        const peerNode = NODES.find((n) => n.id === p.id);
        return `${p.host.padEnd(14)}${(peerNode?.region ?? "-").padEnd(10)}${rtt.padEnd(8)}${loss.padEnd(8)}${peerNode?.proto ?? "-"}`;
      });
      return {
        out: [
          { kind: "out", text: header },
          ...rows.map((r) => ({ kind: "out", text: r }) as TermLine),
        ],
        cwd,
      };
    }
    if (argv[1] === "show" || argv[1] === "--version") {
      return {
        out: lines(
          `easytier ${node.version}
host: ${node.host}
ipv4: ${node.ip}
tunnel: ${node.proto}
peers: 11
uptime: 14d 03:21:14`,
        ),
        cwd,
      };
    }
  }
  if (head === "systemctl" && argv[1] === "status") {
    const svc = argv[2] || "easytier";
    return {
      out: lines(
        `● ${svc}.service - Cobweb mesh agent
     Loaded: loaded (/etc/systemd/system/${svc}.service; enabled)
     Active: active (running) since Mon 2026-05-12 09:14:42 CST; 3 days ago
   Main PID: 4821 (${svc})
      Tasks: 8 (limit: 38123)
     Memory: 24.6M
        CPU: 2m 14.182s`,
      ),
      cwd,
    };
  }
  if (head === "cat" || head === "tail" || head === "head") {
    const path = argv[1] || "";
    if (!path) return { out: [{ kind: "err", text: `${head}: missing operand` }], cwd, exit: 1 };
    return {
      out: [{ kind: "err", text: `${head}: ${path}: No such file or directory` }],
      cwd,
      exit: 1,
    };
  }
  return {
    out: [
      {
        kind: "err",
        text: `${head}: command not found (mock terminal — try: ls, uptime, ip a, ps, easytier-cli show peers, systemctl status easytier)`,
      },
    ],
    cwd,
    exit: 127,
  };
}
