import type { Node } from "$lib/data/mock-nodes";
import type { CtxMenuItem } from "$lib/state/ui.svelte";
import { openDrill, openSSH, selectNode } from "$lib/state/ui.svelte";

export function cellMenuItems(rowNode: Node, colNode: Node): CtxMenuItem[] {
  const isDiag = rowNode.id === colNode.id;
  const sshTarget = (n: Node): CtxMenuItem => {
    const reachable = !(n.mesh === "offline" && n.agent === "offline");
    return {
      label: `Open SSH · ${n.host}`,
      sub: n.agent === "online" ? "via agent" : n.mesh !== "offline" ? "via ssh" : "unreachable",
      disabled: !reachable,
      onClick: () => openSSH(n.id),
    };
  };
  if (isDiag) {
    return [
      { label: `Open node detail · ${rowNode.host}`, onClick: () => selectNode(rowNode.id) },
      sshTarget(rowNode),
      { divider: true },
      {
        label: "Re-probe peers",
        sub: `easytier-cli probe --from=${rowNode.host}`,
        onClick: () => {},
      },
      { label: "Copy hostname", onClick: () => navigator.clipboard?.writeText(rowNode.host) },
    ];
  }
  return [
    {
      label: `Drill down · ${rowNode.host} → ${colNode.host}`,
      hint: "latency / loss timeline",
      onClick: () => openDrill({ aId: rowNode.id, bId: colNode.id, x: 200, y: 200 }),
    },
    { divider: true },
    { label: `Open node detail · ${rowNode.host}`, onClick: () => selectNode(rowNode.id) },
    { label: `Open node detail · ${colNode.host}`, onClick: () => selectNode(colNode.id) },
    { divider: true },
    sshTarget(rowNode),
    sshTarget(colNode),
    { divider: true },
    {
      label: "Re-probe link",
      sub: `easytier-cli probe ${rowNode.host} ${colNode.host}`,
      onClick: () => {},
    },
    { label: "Copy link metrics", hint: "rtt · loss · tx", onClick: () => {} },
  ];
}

export function nodeMenuItems(node: Node): CtxMenuItem[] {
  const reachable = !(node.mesh === "offline" && node.agent === "offline");
  return [
    { label: `Open node detail · ${node.host}`, onClick: () => selectNode(node.id) },
    {
      label: `Open SSH · ${node.host}`,
      sub:
        node.agent === "online" ? "via agent" : node.mesh !== "offline" ? "via ssh" : "unreachable",
      disabled: !reachable,
      onClick: () => openSSH(node.id),
    },
    { divider: true },
    { label: "Re-probe peers", sub: `from ${node.host}`, onClick: () => {} },
    { label: "Restart agent", onClick: () => {} },
    { label: "Restart easytier", onClick: () => {} },
    { divider: true },
    { label: "Copy hostname", onClick: () => navigator.clipboard?.writeText(node.host) },
    { label: "Copy ipv4", sub: node.ip, onClick: () => navigator.clipboard?.writeText(node.ip) },
  ];
}
