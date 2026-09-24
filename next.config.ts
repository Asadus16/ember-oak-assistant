import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A package-lock.json exists in the home directory, so state this project as the root explicitly.
  turbopack: { root: process.cwd() },
};

export default nextConfig;
