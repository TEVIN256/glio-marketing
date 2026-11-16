import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pg loads optional native bindings dynamically; keep it out of the bundle.
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
};

export default nextConfig;
