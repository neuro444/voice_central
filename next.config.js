/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    // Keep Voice Central's own /api routes authoritative. Unknown API and
    // webhook paths still fall back to the established CakeWorld backend.
    // A flat rewrite array runs before dynamic filesystem routes and was
    // swallowing /api/shared-menu/[restaurant] and agent-routing.
    return {
      fallback: [
        {
          source: "/api/:path*",
          destination: "http://localhost:8000/api/:path*",
        },
        {
          source: "/webhook/:path*",
          destination: "http://localhost:8000/webhook/:path*",
        },
      ],
    };
  },
};

module.exports = nextConfig;
