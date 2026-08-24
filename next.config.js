/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://localhost:8000/api/:path*",
      },
      {
        source: "/webhook/:path*",
        destination: "http://localhost:8000/webhook/:path*",
      },
    ];
  },
};

module.exports = nextConfig;
