import React from "react";

export type RendererLinkProps = {
  children?: React.ReactNode;
  href?: string;
  url?: string;
  fallback?: React.ReactNode;
};

export function Link({ children, href, url, fallback }: RendererLinkProps): React.ReactElement {
  const target = href ?? url ?? "";
  return React.createElement("swarm-link", { href: target }, children ?? fallback ?? target);
}

export default Link;
